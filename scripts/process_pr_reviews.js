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

    // Array to store PRs that are ready to merge
    const readyToMergePRs = [];

    // Get total number of open PRs
    const totalOpenPRs = prData.data.repository.pullRequests.nodes.length;

    // Map to store full names for each reviewer
    const reviewerNames = {};

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
        .pr-table th:nth-child(1),
        .pr-table td:nth-child(1) { width: 35%; } /* PR link */
        .pr-table th:nth-child(2),
        .pr-table td:nth-child(2) { width: 10%; } /* Author */
        .pr-table th:nth-child(3),
        .pr-table td:nth-child(3) { width: 35%; } /* Reviewers */
        .pr-table th:nth-child(4),
        .pr-table td:nth-child(4) { width: 5%; } /* # Days Open */      
        .pr-table th:nth-child(5),
        .pr-table td:nth-child(5) { width: 5%; } /* # Approvals */
        .pr-table th:nth-child(6),
        .pr-table td:nth-child(6) { width: 10%; } /* Status */
        
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
        .chart-value {
            position: absolute;
            right: -30px;
            top: 3px;
            font-weight: bold;
            color: #ff9800;
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
        function filterTable(reviewer) {
            console.log("Filtering for reviewer:", reviewer);
            
            // Update the URL with the reviewer parameter if it's not 'all'
            if (reviewer !== 'all') {
                // Use replaceState to update URL without adding to browser history
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('reviewer', reviewer);
                window.history.replaceState({}, '', newUrl);
                console.log("Updated URL with reviewer param:", reviewer);
            } else {
                // Remove the reviewer parameter if 'all' is selected
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.delete('reviewer');
                window.history.replaceState({}, '', newUrl);
                console.log("Removed reviewer param from URL");
            }
            
            // Apply filtering to the table rows
            let rows = document.querySelectorAll('.reviewer-row');
            rows.forEach(row => {
                const shouldShow = (reviewer === 'all' || row.dataset.reviewer.toLowerCase() === reviewer.toLowerCase());
                row.style.display = shouldShow ? '' : 'none';
                console.log("Row:", row.dataset.reviewer, "Display:", shouldShow ? 'showing' : 'hidden');
            });
        }
        
        // Function to apply reviewer filter from URL if present (case-insensitive)
        function applyReviewerFilterFromUrl() {
            const params = getUrlParams();
            
            if (params.reviewer) {
                const reviewerParam = params.reviewer.toLowerCase();
                console.log("Found reviewer param:", reviewerParam);
                
                // Find matching radio button (case-insensitive)
                let found = false;
                const reviewerRadios = document.querySelectorAll('input[name="reviewerFilter"]');
                
                reviewerRadios.forEach(radio => {
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
            }
        }
        
        function filterByStatus(filterType) {
            // Hide chart if it's visible and we're switching to a non-chart filter
            if (filterType !== 'chart') {
                const chartContainer = document.getElementById('chart-container');
                const reviewerTable = document.querySelector('.reviewer-table');
                const radioContainer = document.querySelector('.radio-container');
                
                // Show the regular view
                chartContainer.style.display = 'none';
                reviewerTable.style.display = 'table';
                radioContainer.style.display = 'block';
                
                // Show PR details
                const prRowTables = document.querySelectorAll('.reviewer-row.pr-row-table');
                prRowTables.forEach(prRowTable => {
                    prRowTable.classList.remove('hidden');
                });
            }
            
            // For 'all' (Report view), show all PRs with pending highlight for pending PRs
            if (filterType === 'all') {
                let detailRows = document.querySelectorAll('tr.pr-detail-row');
                detailRows.forEach(row => {
                    const isPending = row.hasAttribute('data-pending') && row.getAttribute('data-pending') === 'true';
                    if (isPending) {
                        row.classList.add('pending-review');
                    } else {
                        row.classList.remove('pending-review');
                    }
                    row.style.display = '';
                });
                
                // If we're not filtering by reviewer, show all reviewer rows
                if (document.querySelector('input[name="reviewerFilter"][value="all"]').checked) {
                    document.querySelectorAll('.reviewer-row').forEach(row => {
                        row.style.display = '';
                    });
                } else {
                    // Re-apply the current reviewer filter
                    const selectedReviewer = document.querySelector('input[name="reviewerFilter"]:checked').value;
                    filterTable(selectedReviewer);
                }
            }
        }
        
        function toggleDetails() {
            const chartRadio = document.getElementById('show-chart');
            const chartContainer = document.getElementById('chart-container');
            const reviewerTable = document.querySelector('.reviewer-table');
            const prRowTables = document.querySelectorAll('.reviewer-row.pr-row-table');
            const radioContainer = document.querySelector('.radio-container');
            
            // When chart mode is enabled
            if (chartRadio.checked) {
                // Show only the chart
                chartContainer.style.display = 'block';
                reviewerTable.style.display = 'none';
                radioContainer.style.display = 'none';
                
                // Ensure PR details are hidden
                prRowTables.forEach(prRowTable => {
                    prRowTable.classList.add('hidden');
                });
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
            
            // Check for reviewer in URL and apply filter with a slight delay
            // to ensure all elements are properly initialized
            setTimeout(function() {
                applyReviewerFilterFromUrl();
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
            ${readyToMergePRs.length > 0 ? `<a href="#ready-section" class="nav-link">Ready To Merge (${readyToMergePRs.length})</a>` : ''}
        </div>
        <span class="total-prs-badge">Total # Of Open PRs: ${totalOpenPRs}</span>
        <button id="toggleLegendBtn" onClick="toggleLegend()" style="margin-left: 15px; background-color: #333; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 4px;">Show Legend</button>
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
          <h4>Visual Indicators</h4>
          <div class="legend-item">
            <div class="legend-pending-sample">Pull Request requiring your review</div>
            Pull Requests that need your review are highlighted with an orange left border
          </div>
          <div class="legend-item">
            <span class="pending-badge">3</span> The number in the orange badge shows how many pending reviews
          </div>
          <div class="legend-item">
            <span style="color: yellow;">Yellow</span> / <span style="color: orange;">Orange</span> / <span style="color: red;">Red</span> days count: Indicates how long the Pull Request has been open
          </div>
          <div class="legend-item">
            Your username will appear first in the reviewers list for easy identification
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
    </div>
    
    <div class="radio-container">
        <label><input type="radio" name="reviewerFilter" value="all" checked onclick="filterTable('all')"> Show All Reviewers</label>`;

    /** Reviewer's radiobuttons with full names **/

    htmlContent += `<table style="margin-top: 8px; margin-bottom: 24px;">
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
    htmlContent += `</tr></table>`;

    /** Reviewers Table **/

    htmlContent += `</div>
    <table class="reviewer-table">
        <tr>
            <th style="width: 28%;">Reviewer</th>
            <th># Reviews Requested (Pending)</th>
        </tr>`;

    /** Reviewer's PR Table with full names **/

        // Prepare reviewer data for the chart
    const chartData = [];
    Object.entries(reviewers).forEach(([reviewer, data]) => {
        if (data.pending > 0) {
            chartData.push({ reviewer, pending: data.pending });
        }

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
            <table class="pr-table">
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

    <script>
        // Variable to track current sort order
        let sortAscending = false;
        
        // Draw the horizontal bar chart
        function drawHorizontalChart() {
            const chartContainer = document.getElementById('horizontal-chart');
            chartContainer.innerHTML = ''; // Clear existing content
            
            // Get chart data
            const chartData = ${JSON.stringify(chartData)};
            
            // Sort data by pending reviews based on current sort direction
            if (sortAscending) {
                chartData.sort((a, b) => a.pending - b.pending); // Ascending (lowest first)
            } else {
                chartData.sort((a, b) => b.pending - a.pending); // Descending (highest first)
            }
            
            // Find the maximum value to calculate bar widths
            const maxValue = Math.max(...chartData.map(item => item.pending));
            const maxBarWidth = 800; // Maximum width for the bars in pixels
            
            // Create and append chart rows
            chartData.forEach(item => {
                const row = document.createElement('div');
                row.className = 'chart-row';
                
                const label = document.createElement('div');
                label.className = 'chart-label';
                
                // Get the full name for the chart label if available
                const fullName = ${JSON.stringify(reviewerNames)}[item.reviewer] || '';
                const displayName = fullName ? \`\${fullName} (\${item.reviewer})\` : item.reviewer;
                
                label.textContent = displayName;
                label.title = displayName; // Add tooltip for truncated names
                
                const barContainer = document.createElement('div');
                barContainer.style.flex = '1';
                
                const bar = document.createElement('div');
                bar.className = 'chart-bar';
                const width = (item.pending / maxValue) * maxBarWidth;
                bar.style.width = width + 'px';
                
                const value = document.createElement('div');
                value.className = 'chart-value';
                value.textContent = item.pending;
                
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
            drawHorizontalChart();
        }
        
        // Set up event handlers when the page loads
        document.addEventListener('DOMContentLoaded', function() {
            drawHorizontalChart();
            // Add click handler for sort toggle button
            const toggleButton = document.getElementById('toggle-sort');
            toggleButton.addEventListener('click', toggleSortOrder);
            
            // Add click handler for return to table button
            const returnButton = document.getElementById('return-to-table');
            returnButton.addEventListener('click', function() {
                document.getElementById('show-all-prs').checked = true;
                filterByStatus('all');
            });
        });
    </script>
</body>
</html>`;

    const path = require('path');
    const outputDir = './webpage';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outputDir, 'index.html'), htmlContent, 'utf8');
}