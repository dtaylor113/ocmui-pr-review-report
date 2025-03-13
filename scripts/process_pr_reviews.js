const fs = require('fs'); // Ensure fs is required at the top

let prData;

const path = './pr_review_report.json';

if (process.env.PR_REPORT_PATH) {
    // If environment variable is set, use synchronous loading
    try {
        const data = fs.readFileSync(process.env.PR_REPORT_PATH, 'utf8');
        prData = JSON.parse(data);
        processData();
    } catch (err) {
        console.error('Error reading or parsing file:', err);
        process.exit(1);
    }
} else {
    // Original asynchronous code kept for backward compatibility
    fs.readFile(path, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading file:', err);
            return;
        }
        console.log('Processing data from pr_review_report.json...');
        prData = JSON.parse(data);
        processData();
    });
}

function processData() {
    // Data structures to track reviewers and their PRs
    const reviewers = {};
    const pendingReviewers = {};

    // Data structure to track authors and their PRs
    const authors = {};

    // Array to store PRs that are ready to merge
    const readyToMergePRs = [];

    // Get total number of open PRs
    const totalOpenPRs = prData.data.repository.pullRequests.nodes.length;

    // Map to store full names for each reviewer and author
    const reviewerNames = {};
    const authorNames = {};

    // Map review states to readable format
    const reviewStateMap = {
        APPROVED: 'approved',
        CHANGES_REQUESTED: 'requested changes',
        COMMENTED: 'commented',
        DISMISSED: 'dismissed',
        PENDING: 'pending',
    };

    // Get last updated timestamp
    const lastUpdatedUTC = new Date();

    // Number of approvals required to merge a PR (repo rule)
    const REQUIRED_APPROVALS = 3;

    // Process each PR
    prData.data.repository.pullRequests.nodes.forEach((pr) => {
        const prNumber = pr.number;
        const prTitle = pr.title;
        const prAuthor = pr.author?.login || 'Unknown';

        // Store author's full name if available
        if (pr.author?.name && pr.author?.login) {
            authorNames[pr.author.login] = pr.author.name;
        }

        // Calculate # Days Open
        const prCreatedDate = new Date(pr.createdAt);
        const lastUpdatedDate = new Date(); // The last time this script ran
        const daysOpen = Math.floor((lastUpdatedDate - prCreatedDate) / (1000 * 60 * 60 * 24)); // Convert ms to days

        // Apply color coding for # Days Open
        let color = '#d4d4d4'; // Default (white)
        if (daysOpen > 6) color = 'red';
        else if (daysOpen > 4) color = 'orange';
        else if (daysOpen > 2) color = 'yellow';

        // Extract requested reviewers
        const requestedReviewers =
            pr.reviewRequests?.nodes
                .map((req) => {
                    const reviewer = req.requestedReviewer;
                    if (!reviewer) return null;

                    // Store the reviewer's full name if available
                    if (reviewer.name && reviewer.login) {
                        reviewerNames[reviewer.login] = reviewer.name;
                    }

                    return reviewer.login;
                })
                .filter(Boolean) || [];

        // Extract reviewers who have already provided feedback and their status
        const reviewerStatus = {};
        pr.reviews?.nodes.forEach((review) => {
            const reviewer = review.author?.login;
            // Skip if reviewer is the PR author (self-reviews)
            if (!reviewer || reviewer === pr.author?.login) return;

            // Store the reviewer's full name if available
            if (review.author?.name && review.author?.login) {
                reviewerNames[review.author.login] = review.author.name;
            }

            // Track the most significant state for each reviewer
            // Priority: CHANGES_REQUESTED > APPROVED > COMMENTED > DISMISSED
            const currentState = reviewerStatus[reviewer];
            const newState = review.state;

            if (
                !currentState ||
                newState === 'CHANGES_REQUESTED' ||
                (currentState !== 'CHANGES_REQUESTED' && newState === 'APPROVED') ||
                (currentState !== 'CHANGES_REQUESTED' &&
                    currentState !== 'APPROVED' &&
                    newState === 'COMMENTED')
            ) {
                reviewerStatus[reviewer] = newState;
            }
        });

        // Count the number of approvals
        const approvalCount =
            Object.values(reviewerStatus).filter((state) => state === 'APPROVED').length || 0;

        // Determine PR status
        let prStatus = 'needs_review';
        if (approvalCount >= REQUIRED_APPROVALS) {
            prStatus = 'ready_to_merge';

            // Add to ready to merge PRs array
            const reviewersWithApprovals = Object.entries(reviewerStatus)
                .filter(([_, state]) => state === 'APPROVED')
                .map(([reviewer, _]) => reviewer);

            readyToMergePRs.push({
                number: prNumber,
                title: prTitle,
                author: prAuthor,
                daysOpen,
                daysOpenColor: color,
                approvals: approvalCount,
                requiredApprovals: REQUIRED_APPROVALS,
                approvedBy: reviewersWithApprovals.join(', ')
            });
        } else if (Object.values(reviewerStatus).includes('CHANGES_REQUESTED')) {
            prStatus = 'changes_requested';
        }

        // Format reviewers with their status
        const reviewersWithStatus = [];

        // First add requested reviewers (who haven't reviewed yet)
        requestedReviewers.forEach((reviewer) => {
            if (!reviewerStatus[reviewer]) {
                reviewersWithStatus.push(`${reviewer} (requested)`);
            }
        });

        // Then add reviewers who have provided feedback
        Object.entries(reviewerStatus).forEach(([reviewer, state]) => {
            reviewersWithStatus.push(`${reviewer} (${reviewStateMap[state] || state.toLowerCase()})`);
        });

        // Track pending reviewers
        requestedReviewers.forEach((reviewer) => {
            if (!pendingReviewers[reviewer]) {
                pendingReviewers[reviewer] = { pending: 0, prDetails: [] };
            }
            pendingReviewers[reviewer].pending += 1;
            pendingReviewers[reviewer].prDetails.push({
                number: prNumber,
                title: prTitle,
                author: prAuthor,
                daysOpen,
                daysOpenColor: color,
                reviewers: reviewersWithStatus.join(', '),
                approvals: approvalCount,
                status: prStatus,
            });
        });

        // Track all reviewers (both requested and those who have reviewed)
        const allReviewers = [...new Set([...requestedReviewers, ...Object.keys(reviewerStatus)])];
        allReviewers.forEach((reviewer) => {
            if (!reviewers[reviewer]) {
                reviewers[reviewer] = { pending: 0, prDetails: [] };
            }

            // Determine if this review is pending:
            // 1. If reviewer is requested and hasn't reviewed yet
            // 2. If reviewer has commented (but not approved)
            // 3. If reviewer has requested changes
            // 4. If reviewer status is explicitly "pending"
            let isPending = false;

            if (requestedReviewers.includes(reviewer) && !reviewerStatus[reviewer]) {
                // Case 1: Requested but hasn't reviewed
                isPending = true;
            } else if (reviewerStatus[reviewer]) {
                // Case 2-4: Check review status
                const status = reviewerStatus[reviewer];
                isPending = status === 'COMMENTED' || status === 'CHANGES_REQUESTED' || status === 'PENDING';
            }
            if (isPending) {
                reviewers[reviewer].pending += 1;
            }

            // If this PR doesn't already exist in this reviewer's list
            const exists = reviewers[reviewer].prDetails.some((detail) => detail.number === prNumber);
            if (!exists) {
                reviewers[reviewer].prDetails.push({
                    number: prNumber,
                    title: prTitle,
                    author: prAuthor,
                    daysOpen,
                    daysOpenColor: color,
                    reviewers: reviewersWithStatus.join(', '),
                    approvals: approvalCount,
                    status: prStatus,
                    isPending: isPending,
                    sortOrder: isPending ? 0 : 1, // Pending PRs will sort to the top
                });
            }
        });

        // Track authors and their PRs
        if (!authors[prAuthor]) {
            authors[prAuthor] = { count: 0, prDetails: [] };
        }

        authors[prAuthor].count += 1;
        authors[prAuthor].prDetails.push({
            number: prNumber,
            title: prTitle,
            daysOpen,
            daysOpenColor: color,
            reviewers: reviewersWithStatus.join(', '),
            approvals: approvalCount,
            status: prStatus,
        });
    });

    // Generate HTML report
    let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${process.env.PROJECT_OWNER}/${process.env.PROJECT_NAME} Open Pull Requests</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #121212; color: #ffffff; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: none; padding: 8px; text-align: left; }
        th { background-color: #333; }
        .pr-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
            background-color: rgba(255, 255, 255, 0.1);
            table-layout: fixed; /* Forces columns to respect set widths */
            margin-left: 24px;
            margin-top: 0px;
        }
        .pr-table th, .pr-table td {
            border: none;
            padding: 6px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        /* Reviewer view PR table column widths */
        .reviewer-pr-table th:nth-child(1),
        .reviewer-pr-table td:nth-child(1) { width: 35%; } /* PR link */
        .reviewer-pr-table th:nth-child(2),
        .reviewer-pr-table td:nth-child(2) { width: 10%; } /* Author */
        .reviewer-pr-table th:nth-child(3),
        .reviewer-pr-table td:nth-child(3) { width: 35%; } /* Reviewers */
        .reviewer-pr-table th:nth-child(4),
        .reviewer-pr-table td:nth-child(4) { width: 5%; } /* # Days Open */      
        .reviewer-pr-table th:nth-child(5),
        .reviewer-pr-table td:nth-child(5) { width: 5%; } /* # Approvals */
        .reviewer-pr-table th:nth-child(6),
        .reviewer-pr-table td:nth-child(6) { width: 10%; } /* Status */
        
        /* Author view PR table column widths */
        .author-pr-table th:nth-child(1),
        .author-pr-table td:nth-child(1) { width: 40%; } /* PR link */
        .author-pr-table th:nth-child(2),
        .author-pr-table td:nth-child(2) { width: 40%; } /* Reviewers */
        .author-pr-table th:nth-child(3),
        .author-pr-table td:nth-child(3) { width: 5%; } /* # Days Open */      
        .author-pr-table th:nth-child(4),
        .author-pr-table td:nth-child(4) { width: 5%; } /* # Approvals */
        .author-pr-table th:nth-child(5),
        .author-pr-table td:nth-child(5) { width: 10%; } /* Status */
        
        /* Ready to Merge table styles */
        .ready-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
            background-color: rgba(76, 175, 80, 0.1); /* Light green background */
            margin-top: 20px;
            border-radius: 4px;
            overflow: hidden;
        }
        .ready-table th {
            background-color: rgba(76, 175, 80, 0.5); /* Darker green header */
            color: white;
            padding: 10px 8px;
        }
        .ready-table td {
            padding: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .ready-table th:nth-child(1),
        .ready-table td:nth-child(1) { width: 40%; } /* PR title */
        .ready-table th:nth-child(2),
        .ready-table td:nth-child(2) { width: 15%; } /* Author */
        .ready-table th:nth-child(3),
        .ready-table td:nth-child(3) { width: 10%; } /* Days Open */
        .ready-table th:nth-child(4),
        .ready-table td:nth-child(4) { width: 10%; } /* Approvals */
        .ready-table th:nth-child(5),
        .ready-table td:nth-child(5) { width: 25%; } /* Approved By */
        
        .last-updated { font-size: 14px; font-style: italic; float: right; }
        .hidden { display: none; }
        .repo-title { font-family: "Courier New", Courier, monospace; font-size: 24px; font-weight: bold; }
        .pr-link {
            display: inline-block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #1e90ff;
        }
        /* Status colors */
        .needs-review { color: #ff9800; } /* Orange */
        .changes-requested { color: #f44336; } /* Red */
        .ready-to-merge { color: #4caf50; } /* Green */
        
        /* Filter controls */
        .filter-controls {
            margin-bottom: 15px;
            padding: 10px;
            background-color: #1e1e1e;
            border-radius: 4px;
            display: flex;
            align-items: center;
        }
        .filter-controls label {
            margin-right: 15px;
        }
        
        /* View Controls */
        .view-controls {
            margin-top: 10px;
            padding: 10px;
            background-color: #222;
            border-radius: 4px;
            display: flex;
            align-items: center;
        }
        .view-controls label {
            margin-right: 15px;
        }
        .view-selector {
            display: inline-block;
            background-color: #333;
            border-radius: 4px;
            overflow: hidden;
            margin-left: 20px;
        }
        .view-btn {
            background-color: #333;
            color: #aaa;
            border: none;
            padding: 8px 15px;
            cursor: pointer;
        }
        .view-btn.active {
            background-color: #4caf50;
            color: white;
        }
        .view-btn:first-child {
            border-right: 1px solid #555;
        }
        
        /* Pending review highlighting */
        .pending-review {
            border-left: 3px solid #ff9800; /* Orange left border only */
        }
        
        /* Pending review badge */
        .pending-badge {
            display: inline-block;
            background-color: #ff9800;
            color: black;
            font-size: 11px;
            font-weight: bold;
            padding: 0px 4px;
            border-radius: 3px;
            margin-left: 5px;
            vertical-align: middle;
        }
        
        /* Ready to merge badge */
        .merge-badge {
            display: inline-block;
            background-color: #4caf50;
            color: black;
            font-size: 11px;
            font-weight: bold;
            padding: 0px 4px;
            border-radius: 3px;
            margin-left: 5px;
            vertical-align: middle;
        }
        
        /* Total PRs badge */
        .total-prs-badge {
            display: inline-block;
            color: #d4d4d4;
            font-size: 14px;
            margin-left: auto;
            margin-right: 15px;
        }
        
        /* Bigger pending count in main table */
        .pending-count {
            font-size: 18px;
            font-weight: bold;
            color: #ff9800;
        }
        
        /* PR count for authors */
        .pr-count {
            font-size: 18px;
            font-weight: bold;
            color: #1e90ff;
        }
        
        /* Ready to merge section header */
        .ready-section-header {
            background-color: rgba(76, 175, 80, 0.2);
            border-left: 4px solid #4caf50;
            padding: 10px 15px;
            margin-top: 30px;
            border-radius: 0 4px 4px 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .ready-section-header h2 {
            margin: 0;
            font-size: 20px;
            color: #4caf50;
        }
        .ready-count {
            background-color: #4caf50;
            color: white;
            font-size: 16px;
            font-weight: bold;
            padding: 2px 8px;
            border-radius: 12px;
        }
        
        /* Legend styles */
        .legend {
            margin-top: 10px;
            margin-bottom: 15px;
            padding: 15px;
            background-color: #1e1e1e;
            border-radius: 4px;
        }
        .legend h3 {
            margin-top: 0;
            border-bottom: 1px solid #444;
            padding-bottom: 8px;
        }
        .legend-item {
            margin-bottom: 12px;
        }
        .legend-item h4 {
            margin: 0 0 6px 0;
        }
        .legend-grid {
            display: flex;
            width: 100%;
            gap: 15px;
        }
        .legend-box {
            flex: 1;
            padding: 10px;
            background-color: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
        }
        .legend-sample {
            display: inline-block;
            width: 20px;
            height: 12px;
            margin-right: 5px;
            vertical-align: middle;
        }
        .legend-table {
            width: 100%;
            margin-top: 10px;
            border-collapse: collapse;
        }
        .legend-table th, .legend-table td {
            padding: 5px 8px;
            text-align: left;
            border-bottom: 1px solid #333;
        }
        .legend-pending-sample {
            display: inline-block;
            border-left: 3px solid #ff9800;
            padding: 4px 8px;
            margin-bottom: 5px;
        }
        
        /* Bar chart styling */
        .chart-container {
            margin-top: 20px;
            margin-bottom: 30px;
            width: 100%;
            display: none;
            background-color: rgba(30, 30, 30, 0.5);
            padding: 20px;
            border-radius: 6px;
        }
        .chart-row {
            margin-bottom: 8px;
            display: flex;
            align-items: center;
        }
        .chart-label {
            width: 150px;
            text-align: right;
            padding-right: 10px;
            font-size: 14px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chart-bar {
            height: 24px;
            background-color: #ff9800;
            border-radius: 3px;
            min-width: 2px;
            transition: width 0.5s ease-in-out;
            position: relative;
        }
        .author-chart-bar {
            background-color: #1e90ff; /* Different color for author charts */
        }
        .chart-value {
            position: absolute;
            right: -30px;
            top: 3px;
            font-weight: bold;
            color: #ff9800;
        }
        .author-chart-value {
            color: #1e90ff; /* Different color for author charts */
        }
        
        /* Navigation link styles */
        .nav-link {
            display: inline-block;
            background-color: #4caf50;
            color: white;
            padding: 5px 12px;
            border-radius: 4px;
            text-decoration: none;
            margin-left: 15px;
            font-weight: bold;
            transition: background-color 0.2s;
        }
        .nav-link:hover {
            background-color: #3d8b40;
        }
        
        /* Ready to Merge link style - no background, green text */
        .ready-link {
            display: inline-block;
            background-color: transparent; /* No background */
            color: #4caf50; /* Green text */
            padding: 5px 12px;
            text-decoration: none;
            margin-left: 15px;
            font-weight: bold;
        }
        .ready-link:hover {
            text-decoration: underline;
        }
        .back-to-top {
            display: inline-block;
            background-color: #333;
            color: white;
            padding: 5px 12px;
            border-radius: 4px;
            text-decoration: none;
            margin-left: 15px;
            font-size: 14px;
            transition: background-color 0.2s;
        }
        .back-to-top:hover {
            background-color: #555;
        }
    </style>
    <script>
        // Global variables for view state
        let currentView = 'reviewers'; // 'reviewers' or 'authors'
        
        // Global data for charts
        var reviewerChartData = ${JSON.stringify(chartData)};
        var authorData = ${JSON.stringify(authors)};
        var authorNames = ${JSON.stringify(authorNames)};
        var reviewerNames = ${JSON.stringify(reviewerNames)};
        
        // Function to get URL query parameters
        function getUrlParams() {
            const params = {};
            const queryString = window.location.search;
            
            if (queryString) {
                const urlParams = new URLSearchParams(queryString);
                urlParams.forEach((value, key) => {
                    params[key] = value;
                });
            }
            return params;
        }
        
        // Enhanced filterTable function that updates the URL and applies filtering
        function filterTable(filterValue) {
            console.log("Filtering for:", filterValue);
            
            // Update the URL with the filter parameter if it's not 'all'
            if (filterValue !== 'all') {
                // Use replaceState to update URL without adding to browser history
                const newUrl = new URL(window.location.href);
                if (currentView === 'reviewers') {
                    newUrl.searchParams.set('reviewer', filterValue);
                    newUrl.searchParams.delete('author');
                } else {
                    newUrl.searchParams.set('author', filterValue);
                    newUrl.searchParams.delete('reviewer');
                }
                window.history.replaceState({}, '', newUrl);
                console.log("Updated URL with filter param:", filterValue);
            } else {
                // Remove the filter parameters if 'all' is selected
                const newUrl = new URL(window.location.href);
                if (currentView === 'reviewers') {
                    newUrl.searchParams.delete('reviewer');
                } else {
                    newUrl.searchParams.delete('author');
                }
                window.history.replaceState({}, '', newUrl);
                console.log("Removed filter param from URL");
            }
            
            // Apply filtering to the table rows based on current view
            let rowSelector = currentView === 'reviewers' ? '.reviewer-row' : '.author-row';
            let dataAttr = currentView === 'reviewers' ? 'data-reviewer' : 'data-author';
            
            let rows = document.querySelectorAll(rowSelector);
            rows.forEach(row => {
                const shouldShow = (filterValue === 'all' || row.getAttribute(dataAttr).toLowerCase() === filterValue.toLowerCase());
                row.style.display = shouldShow ? '' : 'none';
                console.log("Row:", row.getAttribute(dataAttr), "Display:", shouldShow ? 'showing' : 'hidden');
            });
        }
        
        // Function to apply filter from URL if present (case-insensitive)
        function applyFilterFromUrl() {
            const params = getUrlParams();
            
            if (currentView === 'reviewers' && params.reviewer) {
                const reviewerParam = params.reviewer.toLowerCase();
                console.log("Found reviewer param:", reviewerParam);
                
                // Find matching radio button (case-insensitive)
                let found = false;
                const filterRadios = document.querySelectorAll('input[name="reviewerFilter"]');
                
                filterRadios.forEach(radio => {
                    if (radio.value.toLowerCase() === reviewerParam) {
                        console.log("Found radio button for reviewer:", radio.value);
                        // Select this radio button
                        radio.checked = true;
                        
                        // Apply the filter
                        filterTable(radio.value);
                        found = true;
                    }
                });
                
                if (!found) {
                    console.log("No matching reviewer found for:", reviewerParam);
                }
            } else if (currentView === 'authors' && params.author) {
                const authorParam = params.author.toLowerCase();
                console.log("Found author param:", authorParam);
                
                // Find matching radio button (case-insensitive)
                let found = false;
                const filterRadios = document.querySelectorAll('input[name="authorFilter"]');
                
                filterRadios.forEach(radio => {
                    if (radio.value.toLowerCase() === authorParam) {
                        console.log("Found radio button for author:", radio.value);
                        // Select this radio button
                        radio.checked = true;
                        
                        // Apply the filter
                        filterTable(radio.value);
                        found = true;
                    }
                });
                
                if (!found) {
                    console.log("No matching author found for:", authorParam);
                }
            }
        }
        
        function filterByStatus(filterType) {
            // Hide chart if it's visible and we're switching to a non-chart filter
            if (filterType !== 'chart') {
                const chartContainer = document.getElementById('chart-container');
                const mainTable = currentView === 'reviewers' ? 
                                document.querySelector('.reviewer-table') : 
                                document.querySelector('.author-table');
                const radioContainer = document.querySelector('.radio-container');
                
                // Show the regular view
                chartContainer.style.display = 'none';
                mainTable.style.display = 'table';
                radioContainer.style.display = 'block';
                
                // Show PR details
                const selector = currentView === 'reviewers' ? 
                               '.reviewer-row.pr-row-table' : 
                               '.author-row.pr-row-table';
                const prRowTables = document.querySelectorAll(selector);
                prRowTables.forEach(prRowTable => {
                    prRowTable.classList.remove('hidden');
                });
            }
            
            // For 'all' (Report view), show all PRs with pending highlight for pending PRs
            if (filterType === 'all') {
                let detailRows = document.querySelectorAll('tr.pr-detail-row');
                detailRows.forEach(row => {
                    if (currentView === 'reviewers') {
                        const isPending = row.hasAttribute('data-pending') && row.getAttribute('data-pending') === 'true';
                        if (isPending) {
                            row.classList.add('pending-review');
                        } else {
                            row.classList.remove('pending-review');
                        }
                    } else {
                        // In author view, we don't highlight pending rows
                        row.classList.remove('pending-review');
                    }
                    row.style.display = '';
                });
                
                // Reapply the current filter
                const filterName = currentView === 'reviewers' ? 'reviewerFilter' : 'authorFilter';
                const selectedFilter = document.querySelector('input[name="' + filterName + '"]:checked').value;
                filterTable(selectedFilter);
            }
        }
        
        function toggleDetails() {
            const chartRadio = document.getElementById('show-chart');
            const chartContainer = document.getElementById('chart-container');
            const mainTable = currentView === 'reviewers' ? 
                            document.querySelector('.reviewer-table') : 
                            document.querySelector('.author-table');
            const selector = currentView === 'reviewers' ? 
                           '.reviewer-row.pr-row-table' : 
                           '.author-row.pr-row-table';
            const prRowTables = document.querySelectorAll(selector);
            const radioContainer = document.querySelector('.radio-container');
            
            // When chart mode is enabled
            if (chartRadio.checked) {
                // Show only the chart
                chartContainer.style.display = 'block';
                mainTable.style.display = 'none';
                radioContainer.style.display = 'none';
                
                // Ensure PR details are hidden
                prRowTables.forEach(prRowTable => {
                    prRowTable.classList.add('hidden');
                });
                
                // Draw the appropriate chart
                if (currentView === 'reviewers') {
                    drawHorizontalChart('reviewers');
                } else {
                    drawHorizontalChart('authors');
                }
            } else {
                // Only option now is the "Report" view (all)
                filterByStatus('all');
            }
        }
        
        function toggleLegend() {
            const legend = document.getElementById('legend');
            if (legend.classList.contains('hidden')) {
                legend.classList.remove('hidden');
                document.getElementById('toggleLegendBtn').textContent = 'Hide Legend';
            } else {
                legend.classList.add('hidden');
                document.getElementById('toggleLegendBtn').textContent = 'Show Legend';
            }
        }
        
        function switchView(view) {
            currentView = view;
            
            // Update active button styling
            document.querySelectorAll('.view-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            document.getElementById(view + '-view-btn').classList.add('active');
            
            // Hide all views
            document.getElementById('reviewers-view').classList.add('hidden');
            document.getElementById('authors-view').classList.add('hidden');
            
            // Show selected view
            document.getElementById(view + '-view').classList.remove('hidden');
            
            // Reset chart container
            const chartContainer = document.getElementById('chart-container');
            chartContainer.style.display = 'none';
            
            // Reset to report view
            document.getElementById('show-all-prs').checked = true;
            
            // Apply filter from URL
            applyFilterFromUrl();
            
            // Update chart if in chart mode
            if (document.getElementById('show-chart').checked) {
                toggleDetails();
            }
        }
        
        // Draw the horizontal bar chart
        function drawHorizontalChart(chartType) {
            const chartContainer = document.getElementById('horizontal-chart');
            chartContainer.innerHTML = ''; // Clear existing content
            
            // Get chart data based on type
            let chartData;
            if (chartType === 'reviewers') {
                chartData = ${JSON.stringify(chartData)};
                document.querySelector('#chart-container h3').textContent = 'Pending Reviews by Reviewer';
            } else {
                // For authors, we use author data
                chartData = [];
                // Convert author data to chart data format
                Object.entries(${JSON.stringify(authors)}).forEach(([author, data]) => {
                    if (data.count > 0) {
                        chartData.push({ author, count: data.count });
                    }
                });
                document.querySelector('#chart-container h3').textContent = 'Pull Requests by Author';
            }
            
            // Sort data based on current sort direction
            if (sortAscending) {
                if (chartType === 'reviewers') {
                    chartData.sort((a, b) => a.pending - b.pending); // Ascending (lowest first)
                } else {
                    chartData.sort((a, b) => a.count - b.count); // Ascending (lowest first)
                }
            } else {
                if (chartType === 'reviewers') {
                    chartData.sort((a, b) => b.pending - a.pending); // Descending (highest first)
                } else {
                    chartData.sort((a, b) => b.count - a.count); // Descending (highest first)
                }
            }
            
            // Find the maximum value to calculate bar widths
            const maxValue = Math.max(...chartData.map(item => 
                chartType === 'reviewers' ? item.pending : item.count));
            const maxBarWidth = 800; // Maximum width for the bars in pixels
            
            // Create and append chart rows
            chartData.forEach(item => {
                const row = document.createElement('div');
                row.className = 'chart-row';
                
                const label = document.createElement('div');
                label.className = 'chart-label';
                
                let displayName;
                if (chartType === 'reviewers') {
                    // Get the full name for reviewers if available
                    const fullName = ${JSON.stringify(reviewerNames)}[item.reviewer] || '';
                    displayName = fullName ? `${fullName} (${item.reviewer})` : item.reviewer;
                } else {
                    // Get the full name for authors if available
                    const fullName = ${JSON.stringify(authorNames)}[item.author] || '';
                    displayName = fullName ? `${fullName} (${item.author})` : item.author;
                }
                
                label.textContent = displayName;
                label.title = displayName; // Add tooltip for truncated names
                
                const barContainer = document.createElement('div');
                barContainer.style.flex = '1';
                
                const bar = document.createElement('div');
                bar.className = chartType === 'reviewers' ? 'chart-bar' : 'chart-bar author-chart-bar';
                const width = ((chartType === 'reviewers' ? item.pending : item.count) / maxValue) * maxBarWidth;
                bar.style.width = width + 'px';
                
                const value = document.createElement('div');
                value.className = chartType === 'reviewers' ? 'chart-value' : 'chart-value author-chart-value';
                value.textContent = chartType === 'reviewers' ? item.pending : item.count;
                
                bar.appendChild(value);
                barContainer.appendChild(bar);
                
                row.appendChild(label);
                row.appendChild(barContainer);
                
                chartContainer.appendChild(row);
            });
        }
        
        // Function to toggle sort order
        function toggleSortOrder() {
            sortAscending = !sortAscending;
            const toggleButton = document.getElementById('toggle-sort');
            toggleButton.textContent = sortAscending ? 'Sort: Lowest First' : 'Sort: Highest First';
            
            if (currentView === 'reviewers') {
                drawHorizontalChart('reviewers');
            } else {
                drawHorizontalChart('authors');
            }
        }
        
        // Variable to track current sort order
        let sortAscending = false;
        
        document.addEventListener("DOMContentLoaded", function() {
            console.log("DOM content loaded");
            const lastUpdatedElement = document.getElementById("lastUpdated");
            const utcTimestamp = lastUpdatedElement.getAttribute("data-utc");
            if (utcTimestamp) {
                var localDate = new Date(utcTimestamp);
                lastUpdatedElement.textContent = "Last Updated: " + localDate.toLocaleString();
            }
            
            // Set default to show all PRs (report view)
            filterByStatus('all');
            
            // Toggle Ready to Merge table visibility
            const toggleReadyBtn = document.getElementById('toggle-ready-btn');
            const readyTable = document.getElementById('ready-table-section');
            
            if (toggleReadyBtn && readyTable) {
                toggleReadyBtn.addEventListener('click', function() {
                    if (readyTable.classList.contains('hidden')) {
                        readyTable.classList.remove('hidden');
                        toggleReadyBtn.textContent = 'Hide Ready to Merge PRs';
                    } else {
                        readyTable.classList.add('hidden');
                        toggleReadyBtn.textContent = 'Show Ready to Merge PRs';
                    }
                });
            }
            
            // Add event listener for view selector buttons
            document.querySelectorAll('.view-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    switchView(this.getAttribute('data-view'));
                });
            });
            
            // Set up sort toggle button
            const toggleButton = document.getElementById('toggle-sort');
            toggleButton.addEventListener('click', toggleSortOrder);
            
            // Add click handler for return to table button
            const returnButton = document.getElementById('return-to-table');
            returnButton.addEventListener('click', function() {
                document.getElementById('show-all-prs').checked = true;
                filterByStatus('all');
            });
            
            // Check for params in URL and apply filter with a slight delay
            // to ensure all elements are properly initialized
            setTimeout(function() {
                // Default view is reviewers
                switchView('reviewers');
                
                // Check if we need to switch to authors view based on URL
                const params = getUrlParams();
                if (params.author) {
                    switchView('authors');
                }
            }, 200);
        });
    </script>
</head>`;

    /** Page Title **/

    htmlContent += `  
<body>
    <h2 id="top">
      <span class="repo-title">${process.env.PROJECT_OWNER}/${process.env.PROJECT_NAME}</span> Open Pull Requests
      <span id="lastUpdated" class="last-updated" data-utc="${lastUpdatedUTC}"></span>
    </h2>
    
    <div class="filter-controls">
        <div>
            <label><input type="radio" name="prFilter" id="show-all-prs" onclick="filterByStatus('all')" checked> Report</label>
            <label><input type="radio" name="prFilter" id="show-chart" onClick="toggleDetails()"> Chart</label>
            ${readyToMergePRs.length > 0 ? `<a href="#ready-section" class="ready-link">Ready To Merge (${readyToMergePRs.length})</a>` : ''}
        </div>
        <span class="total-prs-badge">Total # Of Open PRs: ${totalOpenPRs}</span>
        <button id="toggleLegendBtn" onClick="toggleLegend()" style="margin-left: 15px; background-color: #333; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px;">Show Legend</button>
    </div>
    
    <!-- View selector -->
    <div class="view-controls">
        <span>View by:</span>
        <div class="view-selector">
            <button id="reviewers-view-btn" class="view-btn active" data-view="reviewers">Reviewers View</button>
            <button id="authors-view-btn" class="view-btn" data-view="authors">Authors View</button>
        </div>
    </div>
    
    <!-- Legend positioned between filters and radio buttons -->
    <div id="legend" class="legend hidden">
      <h3>Pull Request Review Report Legend</h3>
      
      <div class="legend-grid">
        <div class="legend-box">
          <h4>Pull Request Status</h4>
          <div class="legend-item">
            <span class="legend-sample" style="background-color: #ff9800;"></span>
            <span class="needs-review">Needs Review</span>: Pull Request needs more reviews before it can be merged
          </div>
          <div class="legend-item">
            <span class="legend-sample" style="background-color: #f44336;"></span>
            <span class="changes-requested">Changes Requested</span>: Pull Request needs code changes based on review feedback
          </div>
          <div class="legend-item">
            <span class="legend-sample" style="background-color: #4caf50;"></span>
            <span class="ready-to-merge">Ready to Merge</span>: Pull Request has all required approvals (${REQUIRED_APPROVALS}) and can be merged
          </div>
        </div>
        
        <div class="legend-box">
          <h4>Reviewer Status</h4>
          <table class="legend-table">
            <tr>
              <th>Status</th>
              <th>Description</th>
            </tr>
            <tr>
              <td><code>username (requested)</code></td>
              <td>Reviewer has been requested but hasn't reviewed yet</td>
            </tr>
            <tr>
              <td><code>username (approved)</code></td>
              <td>Reviewer has approved the Pull Request</td>
            </tr>
            <tr>
              <td><code>username (commented)</code></td>
              <td>Reviewer has commented but not approved or requested changes</td>
            </tr>
            <tr>
              <td><code>username (requested changes)</code></td>
              <td>Reviewer has requested changes that need to be addressed</td>
            </tr>
            <tr>
              <td><code>username (pending)</code></td>
              <td>Started but not submitted review: When a reviewer begins drafting their review in GitHub but hasn't submitted it yet</td>
            </tr>
          </table>
        </div>
        
        <div class="legend-box">
          <h4>Visual Indicators & Views</h4>
          <div class="legend-item">
            <div class="legend-pending-sample">Pull Request requiring your review</div>
            Pull Requests that need your review are highlighted with an orange left border in Reviewers View
          </div>
          <div class="legend-item">
            <span class="pending-badge">3</span> The number in the orange badge shows how many pending reviews in Reviewers View
          </div>
          <div class="legend-item">
            <span style="color: yellow;">Yellow</span> / <span style="color: orange;">Orange</span> / <span style="color: red;">Red</span> days count: Indicates how long the Pull Request has been open
          </div>
          <div class="legend-item">
            <strong>Reviewers View</strong>: Focus on PRs that each reviewer is responsible for reviewing
          </div>
          <div class="legend-item">
            <strong>Authors View</strong>: Focus on PRs created by each author
          </div>
        </div>
      </div>
    </div>
    
    <!-- Bar chart container -->
    <div id="chart-container" class="chart-container">
        <h3>
            Pending Reviews by Reviewer
            <button id="toggle-sort" style="margin-left: 10px; background-color: #333; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px; font-size: 12px;">
                Sort: Highest First
            </button>
            <button id="return-to-table" style="margin-left: 10px; background-color: #555; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px; font-size: 12px;">
                Back to Table View
            </button>
        </h3>
        <div id="horizontal-chart"></div>
    </div>`;

    /* REVIEWERS VIEW */
    htmlContent += `<div id="reviewers-view">
        <div class="radio-container">
            <label><input type="radio" name="reviewerFilter" value="all" checked onclick="filterTable('all')"> Show all</label>
            <table style="margin-top: 8px; margin-bottom: 24px;">
                <tr>`; // Start the first row

    let count = 0;
    Object.keys(reviewers).forEach((reviewer) => {
        if (count % 4 === 0 && count !== 0) {
            htmlContent += `</tr><tr>`; // Close the previous row and start a new one every 4 items
        }

        const pendingCount = reviewers[reviewer].pending;
        // Get the full name for the reviewer, default to empty string if not available
        const fullName = reviewerNames[reviewer] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? `${fullName} (${reviewer})` : reviewer;

        // Pending badge
        const pendingBadge = pendingCount > 0 ? `<span class="pending-badge">${pendingCount}</span>` : '';

        htmlContent += `<td style="text-align: left; padding: 2px;">
        <label><input type="radio" name="reviewerFilter" value="${reviewer}" onclick="filterTable('${reviewer}')"> ${displayName} ${pendingBadge}</label>
    </td>`;
        count++;
    });
    // Close the last row
    htmlContent += `</tr></table>
        </div>
        <table class="reviewer-table">
            <tr>
                <th style="width: 28%;">Reviewer</th>
                <th># Reviews Requested (Pending)</th>
            </tr>`;

    // Reviewer's PR Table with full names
    Object.entries(reviewers).forEach(([reviewer, data]) => {
        // Get the full name for the reviewer, default to empty string if not available
        const fullName = reviewerNames[reviewer] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? `${fullName} (${reviewer})` : reviewer;

        htmlContent += `<tr class="reviewer-row" data-reviewer="${reviewer}">
        <td>${displayName}</td>
        <td><span class="pending-count">${data.pending}</span></td>
    </tr>
  
    <tr class="reviewer-row pr-row-table" data-reviewer="${reviewer}">
        <td colspan="2">
            <table class="pr-table reviewer-pr-table">
                <tr>
                  <th title="Pull Request">Pull Request</th>
                  <th title="Author">Author</th>
                  <th title="Reviewers">Reviewers</th>
                  <th title="# Days Open"># Days</th>
                  <th title="# Approvals"># Approvals</th>
                  <th title="Status">Status</th>
                </tr>`;

        // Sort PR details to put pending reviews at the top
        const sortedPRDetails = [...data.prDetails].sort((a, b) => a.sortOrder - b.sortOrder);

        sortedPRDetails.forEach((pr) => {
            // Set status class for styling
            let statusClass = '';
            let statusText = '';

            switch (pr.status) {
                case 'ready_to_merge':
                    statusClass = 'ready-to-merge';
                    statusText = 'Ready to Merge';
                    break;
                case 'changes_requested':
                    statusClass = 'changes-requested';
                    statusText = 'Changes Requested';
                    break;
                case 'needs_review':
                default:
                    statusClass = 'needs-review';
                    statusText = 'Needs Review';
                    break;
            }

            const pendingClass = pr.isPending ? '' : ''; // Initially no highlight

            // Move current reviewer to the front of the list and highlight it
            let reviewersArray = pr.reviewers.split(', ');

            // Find the current reviewer in the list
            const currentReviewerIndex = reviewersArray.findIndex(item =>
                item.startsWith(reviewer + ' ('));

            // If the current reviewer is in the list, move them to the front
            if (currentReviewerIndex !== -1) {
                const currentReviewer = reviewersArray[currentReviewerIndex];
                // Remove from current position
                reviewersArray.splice(currentReviewerIndex, 1);
                // Add to the front (without special styling now)
                reviewersArray.unshift(currentReviewer);
            }

            // Join the array back into a string
            const reviewersList = reviewersArray.join(', ');

            // Add data-pending attribute to track pending status
            htmlContent += `<tr class="pr-detail-row" data-status="${pr.status}" data-pending="${pr.isPending}">
              <td><a title="${pr.title}" class="pr-link" 
                     href="https://github.com/${process.env.PROJECT_OWNER}/${process.env.PROJECT_NAME}/pull/${pr.number}">${pr.title}
                  </a>
              </td>
              <td title="${pr.author}">${pr.author}</td>
              <td title="${pr.reviewers}">${reviewersList}</td>
              <td title="${pr.daysOpen}" style="color: ${pr.daysOpenColor};">${pr.daysOpen}</td>
              <td title="${pr.approvals}">${pr.approvals}/${REQUIRED_APPROVALS}</td>
              <td class="${statusClass}" title="${statusText}">${statusText}</td>
            </tr>`;
        });

        htmlContent += `</table>
        </td>
    </tr>`;
    });

    htmlContent += `</table>
    </div>`; // End of reviewers view

    /* AUTHORS VIEW */
    htmlContent += `<div id="authors-view" class="hidden">
        <div class="radio-container">
            <label><input type="radio" name="authorFilter" value="all" checked onclick="filterTable('all')"> Show all</label>
            <table style="margin-top: 8px; margin-bottom: 24px;">
                <tr>`; // Start the first row

    count = 0;
    Object.keys(authors).forEach((author) => {
        if (count % 4 === 0 && count !== 0) {
            htmlContent += `</tr><tr>`; // Close the previous row and start a new one every 4 items
        }

        const prCount = authors[author].count;
        // Get the full name for the author, default to empty string if not available
        const fullName = authorNames[author] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? `${fullName} (${author})` : author;

        htmlContent += `<td style="text-align: left; padding: 2px;">
        <label><input type="radio" name="authorFilter" value="${author}" onclick="filterTable('${author}')"> ${displayName}</label>
    </td>`;
        count++;
    });
    // Close the last row
    htmlContent += `</tr></table>
        </div>
        <table class="author-table">
            <tr>
                <th style="width: 28%;">Author</th>
                <th># PRs Created</th>
            </tr>`;

    // Author's PR Table with full names
    Object.entries(authors).forEach(([author, data]) => {
        // Get the full name for the author, default to empty string if not available
        const fullName = authorNames[author] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? `${fullName} (${author})` : author;

        htmlContent += `<tr class="author-row" data-author="${author}">
        <td>${displayName}</td>
        <td><span class="pr-count">${data.count}</span></td>
    </tr>
  
    <tr class="author-row pr-row-table" data-author="${author}">
        <td colspan="2">
            <table class="pr-table author-pr-table">
                <tr>
                  <th title="Pull Request">Pull Request</th>
                  <th title="Reviewers">Reviewers</th>
                  <th title="# Days Open"># Days</th>
                  <th title="# Approvals"># Approvals</th>
                  <th title="Status">Status</th>
                </tr>`;

        // Sort PR details by days open (newest first)
        const sortedPRDetails = [...data.prDetails].sort((a, b) => b.daysOpen - a.daysOpen);

        sortedPRDetails.forEach((pr) => {
            // Set status class for styling
            let statusClass = '';
            let statusText = '';

            switch (pr.status) {
                case 'ready_to_merge':
                    statusClass = 'ready-to-merge';
                    statusText = 'Ready to Merge';
                    break;
                case 'changes_requested':
                    statusClass = 'changes-requested';
                    statusText = 'Changes Requested';
                    break;
                case 'needs_review':
                default:
                    statusClass = 'needs-review';
                    statusText = 'Needs Review';
                    break;
            }

            htmlContent += `<tr class="pr-detail-row" data-status="${pr.status}">
              <td><a title="${pr.title}" class="pr-link" 
                     href="https://github.com/${process.env.PROJECT_OWNER}/${process.env.PROJECT_NAME}/pull/${pr.number}">${pr.title}
                  </a>
              </td>
              <td title="${pr.reviewers}">${pr.reviewers}</td>
              <td title="${pr.daysOpen}" style="color: ${pr.daysOpenColor};">${pr.daysOpen}</td>
              <td title="${pr.approvals}">${pr.approvals}/${REQUIRED_APPROVALS}</td>
              <td class="${statusClass}" title="${statusText}">${statusText}</td>
            </tr>`;
        });

        htmlContent += `</table>
        </td>
    </tr>`;
    });

    htmlContent += `</table>
    </div>`; // End of authors view

    /* READY TO MERGE SECTION */
    htmlContent += `
    <!-- Ready to Merge PRs Section -->
    <div id="ready-section" class="ready-section-header">
        <h2>Ready to Merge Pull Requests</h2>
        <div>
            <span class="ready-count">${readyToMergePRs.length}</span>
            <a href="#top" class="back-to-top">Back to top</a>
        </div>
    </div>
    
    <table class="ready-table" id="ready-table">
        <tr>
            <th>Pull Request</th>
            <th>Author</th>
            <th>Days Open</th>
            <th>Approvals</th>
            <th>Approved By</th>
        </tr>`;

    // Sort ready to merge PRs by days open (newest first)
    readyToMergePRs.sort((a, b) => b.daysOpen - a.daysOpen);

    readyToMergePRs.forEach(pr => {
        htmlContent += `
        <tr>
            <td><a title="${pr.title}" class="pr-link" 
                 href="https://github.com/${process.env.PROJECT_OWNER}/${process.env.PROJECT_NAME}/pull/${pr.number}">${pr.title}</a></td>
            <td>${pr.author}</td>
            <td style="color: ${pr.daysOpenColor};">${pr.daysOpen}</td>
            <td>${pr.approvals}/${pr.requiredApprovals}</td>
            <td title="${pr.approvedBy}">${pr.approvedBy}</td>
        </tr>`;
    });

    // Add message for no PRs ready to merge
    if (readyToMergePRs.length === 0) {
        htmlContent += `
        <tr>
            <td colspan="5" style="text-align: center; padding: 20px;">
                No pull requests are currently ready to merge.
            </td>
        </tr>`;
    }

    htmlContent += `</table>
</body>
</html>`;

    const path = require('path');
    const outputDir = './webpage';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outputDir, 'index.html'), htmlContent, 'utf8');
}