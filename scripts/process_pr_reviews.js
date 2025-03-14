const fs = require('fs'); // Ensure fs is required at the top

// Add this utility function to extract Jira IDs from PR titles
function extractJiraIds(str) {
    if (!str) return [];
    const regex = /OCMUI-\d+/g;
    const matches = str.match(regex) || [];
    return [...new Set(matches)]; // Remove duplicates
}

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
        const isDraft = pr.isDraft || false; // Extract isDraft property

        // Extract Jira IDs from PR title
        const jiraIds = extractJiraIds(prTitle);

        // Format Jira IDs as clickable links
        const jiraLinks = jiraIds.map(id =>
            `<a href="https://issues.redhat.com/browse/${id}" target="_blank">${id}</a>`
        ).join(', ');

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
                approvedBy: reviewersWithApprovals.join(', '),
                isDraft: isDraft, // Add isDraft property
                jiraLinks: jiraLinks // Add Jira links
            });
        } else if (Object.values(reviewerStatus).includes('CHANGES_REQUESTED')) {
            prStatus = 'changes_requested';
        }

        // Format reviewers with their status
        const reviewersWithStatus = [];

        // First add requested reviewers (who haven't reviewed yet)
        requestedReviewers.forEach((reviewer) => {
            if (!reviewerStatus[reviewer]) {
                reviewersWithStatus.push(reviewer + ' (requested)');
            }
        });

        // Then add reviewers who have provided feedback
        Object.entries(reviewerStatus).forEach(([reviewer, state]) => {
            reviewersWithStatus.push(reviewer + ' (' + (reviewStateMap[state] || state.toLowerCase()) + ')');
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
                isDraft: isDraft, // Add isDraft property
                jiraLinks: jiraLinks // Add Jira links
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
                    isDraft: isDraft, // Add isDraft property
                    jiraLinks: jiraLinks // Add Jira links
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
            reviewers: reviewersWithStatus.join(', '), // Make sure to include reviewers
            approvals: approvalCount,
            status: prStatus,
            isDraft: isDraft, // Add isDraft property
            jiraLinks: jiraLinks // Add Jira links
        });
    });

    // Prepare chart data for reviewers
    const reviewerChartData = [];
    Object.entries(reviewers).forEach(([reviewer, data]) => {
        if (data.pending > 0) {
            reviewerChartData.push({ reviewer: reviewer, pending: data.pending });
        }
    });

    // Generate HTML report
    generateHtmlReport(
        reviewers,
        authors,
        reviewerNames,
        authorNames,
        readyToMergePRs,
        totalOpenPRs,
        lastUpdatedUTC,
        REQUIRED_APPROVALS,
        reviewerChartData
    );
}

// Function to generate HTML report - extracted for clarity
function generateHtmlReport(
    reviewers,
    authors,
    reviewerNames,
    authorNames,
    readyToMergePRs,
    totalOpenPRs,
    lastUpdatedUTC,
    REQUIRED_APPROVALS,
    reviewerChartData
) {
    let htmlContent = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
        '    <meta charset="UTF-8">\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        '    <title>' + process.env.PROJECT_OWNER + '/' + process.env.PROJECT_NAME + ' Open Pull Requests</title>\n' +
        '    <style>\n' +
        '        body { font-family: Arial, sans-serif; margin: 20px; background-color: #121212; color: #ffffff; }\n' +
        '        table { width: 100%; border-collapse: collapse; margin-top: 10px; }\n' +
        '        th, td { border: none; padding: 8px; text-align: left; }\n' +
        '        th { background-color: #333; }\n' +
        '        .pr-table {\n' +
        '            width: 100%;\n' +
        '            border-collapse: collapse;\n' +
        '            font-size: 14px;\n' +
        '            background-color: rgba(255, 255, 255, 0.1);\n' +
        '            table-layout: fixed; /* Forces columns to respect set widths */\n' +
        '            margin-left: 24px;\n' +
        '            margin-top: 0px;\n' +
        '        }\n' +
        '        .pr-table th, .pr-table td {\n' +
        '            border: none;\n' +
        '            padding: 6px;\n' +
        '            overflow: hidden;\n' +
        '            text-overflow: ellipsis;\n' +
        '            white-space: nowrap;\n' +
        '        }\n' +
        '        /* Reviewer view PR table column widths */\n' +
        '        .reviewer-pr-table th:nth-child(1),\n' +
        '        .reviewer-pr-table td:nth-child(1) { width: auto; } /* PR link - flexible */\n' +
        '        .reviewer-pr-table th:nth-child(2),\n' +
        '        .reviewer-pr-table td:nth-child(2) { width: 100px; } /* Author - fixed */\n' +
        '        .reviewer-pr-table th:nth-child(3),\n' +
        '        .reviewer-pr-table td:nth-child(3) { width: 105px; white-space: normal !important; overflow: visible; word-break: break-word; } /* Jira - fixed with wrapping */\n' +
        '        .reviewer-pr-table th:nth-child(4),\n' +
        '        .reviewer-pr-table td:nth-child(4) { width: auto; } /* Reviewers - flexible */\n' +
        '        .reviewer-pr-table th:nth-child(5),\n' +
        '        .reviewer-pr-table td:nth-child(5) { width: 60px; } /* # Days Open - fixed */\n' +
        '        .reviewer-pr-table th:nth-child(6),\n' +
        '        .reviewer-pr-table td:nth-child(6) { width: 60px; } /* # Approvals - fixed */\n' +
        '        .reviewer-pr-table th:nth-child(7),\n' +
        '        .reviewer-pr-table td:nth-child(7) { width: 120px; } /* Status - fixed */\n' +
        '        \n' +
        '        /* Author view PR table column widths */\n' +
        '        .author-pr-table th:nth-child(1),\n' +
        '        .author-pr-table td:nth-child(1) { width: auto; } /* PR link - flexible */\n' +
        '        .author-pr-table th:nth-child(2),\n' +
        '        .author-pr-table td:nth-child(2) { width: 105px; white-space: normal !important; overflow: visible; word-break: break-word; } /* Jira - fixed with wrapping */\n' +
        '        .author-pr-table th:nth-child(3),\n' +
        '        .author-pr-table td:nth-child(3) { width: auto; } /* Reviewers - flexible */\n' +
        '        .author-pr-table th:nth-child(4),\n' +
        '        .author-pr-table td:nth-child(4) { width: 60px; } /* # Days Open - fixed */\n' +
        '        .author-pr-table th:nth-child(5),\n' +
        '        .author-pr-table td:nth-child(5) { width: 60px; } /* # Approvals - fixed */\n' +
        '        .author-pr-table th:nth-child(6),\n' +
        '        .author-pr-table td:nth-child(6) { width: 130px; } /* Status - fixed */\n' +
        '        \n' +
        '        /* Ready to Merge table styles */\n' +
        '        .ready-table {\n' +
        '            width: 100%;\n' +
        '            border-collapse: collapse;\n' +
        '            font-size: 14px;\n' +
        '            background-color: rgba(76, 175, 80, 0.1); /* Light green background */\n' +
        '            margin-top: 20px;\n' +
        '            border-radius: 4px;\n' +
        '            overflow: hidden;\n' +
        '        }\n' +
        '        .ready-table th {\n' +
        '            background-color: rgba(76, 175, 80, 0.5); /* Darker green header */\n' +
        '            color: white;\n' +
        '            padding: 10px 8px;\n' +
        '        }\n' +
        '        .ready-table td {\n' +
        '            padding: 8px;\n' +
        '            overflow: hidden;\n' +
        '            text-overflow: ellipsis;\n' +
        '            white-space: nowrap;\n' +
        '        }\n' +
        '        .ready-table th:nth-child(1),\n' +
        '        .ready-table td:nth-child(1) { width: 35%; } /* PR title */\n' +
        '        .ready-table th:nth-child(2),\n' +
        '        .ready-table td:nth-child(2) { width: 12%; } /* Author */\n' +
        '        .ready-table th:nth-child(3),\n' +
        '        .ready-table td:nth-child(3) { width: 8%; } /* Days Open */\n' +
        '        .ready-table th:nth-child(4),\n' +
        '        .ready-table td:nth-child(4) { width: 8%; } /* Approvals */\n' +
        '        .ready-table th:nth-child(5),\n' +
        '        .ready-table td:nth-child(5) { width: 20%; } /* Approved By */\n' +
        '        .ready-table th:nth-child(6),\n' +
        '        .ready-table td:nth-child(6) { width: 17%; } /* Jira - new column */\n' +
        '        \n' +
        '        .last-updated { font-size: 14px; font-style: italic; float: right; }\n' +
        '        .hidden { display: none; }\n' +
        '        .repo-title { font-family: "Courier New", Courier, monospace; font-size: 24px; font-weight: bold; }\n' +
        '        .pr-link {\n' +
        '            display: inline-block;\n' +
        '            overflow: hidden;\n' +
        '            text-overflow: ellipsis;\n' +
        '            white-space: nowrap;\n' +
        '            color: #1e90ff;\n' +
        '        }\n' +
        '        /* Jira link styling - always purple even when visited */\n' +
        '        a[href^="https://issues.redhat.com/browse/"] {\n' +
        '            color: #9370DB !important;\n' +
        '            text-decoration: none;\n' +
        '        }\n' +
        '        a[href^="https://issues.redhat.com/browse/"]:visited {\n' +
        '            color: #9370DB !important;\n' +
        '        }\n' +
        '        /* Status colors */\n' +
        '        .needs-review { color: #ff9800; } /* Orange */\n' +
        '        .changes-requested { color: #f44336; } /* Red */\n' +
        '        .ready-to-merge { color: #4caf50; } /* Green */\n' +
        '        \n' +
        '        /* Filter controls */\n' +
        '        .filter-controls {\n' +
        '            margin-bottom: 15px;\n' +
        '            padding: 10px 10px 10px 5px;\n' +
        '            background-color: transparent;\n' +
        '            border-radius: 4px;\n' +
        '            display: flex;\n' +
        '            align-items: center;\n' +
        '            justify-content: flex-start;\n' +
        '        }\n' +
        '        .filter-controls label {\n' +
        '            margin-right: 15px;\n' +
        '        }\n' +
        '        \n' +
        '        /* View Controls */\n' +
        '        .view-controls {\n' +
        '            margin-top: 5px;\n' +
        '            margin-bottom: 5px;\n' +
        '            padding: 10px 10px 10px 5px;\n' +
        '            background-color: transparent;\n' +
        '            border-radius: 4px;\n' +
        '            display: flex;\n' +
        '            align-items: center;\n' +
        '            justify-content: flex-start;\n' +
        '        }\n' +
        '        .view-controls label {\n' +
        '            margin-right: 15px;\n' +
        '        }\n' +
        '        .view-selector {\n' +
        '            display: inline-block;\n' +
        '            background-color: transparent;\n' +
        '            border-radius: 4px;\n' +
        '            overflow: hidden;\n' +
        '            margin-left: 0px;\n' +
        '        }\n' +
        '        .view-btn {\n' +
        '            background-color: #333;\n' +
        '            color: #aaa;\n' +
        '            border: none;\n' +
        '            padding: 8px 15px;\n' +
        '            cursor: pointer;\n' +
        '        }\n' +
        '        .view-btn.active {\n' +
        '            background-color: #4caf50;\n' +
        '            color: white;\n' +
        '        }\n' +
        '        .view-btn:first-child {\n' +
        '            border-right: 1px solid #555;\n' +
        '        }\n' +
        '        \n' +
        '        /* Pending review highlighting */\n' +
        '        .pending-review {\n' +
        '            border-left: 3px solid #ff9800; /* Orange left border only */\n' +
        '        }\n' +
        '        \n' +
        '        /* Pending review badge */\n' +
        '        .pending-badge {\n' +
        '            display: inline-block;\n' +
        '            background-color: #ff9800;\n' +
        '            color: black;\n' +
        '            font-size: 11px;\n' +
        '            font-weight: bold;\n' +
        '            padding: 0px 4px;\n' +
        '            border-radius: 3px;\n' +
        '            margin-left: 5px;\n' +
        '            vertical-align: middle;\n' +
        '        }\n' +
        '        \n' +
        '        /* Author PR count badge */\n' +
        '        .author-badge {\n' +
        '            display: inline-block;\n' +
        '            background-color: #1e90ff;\n' +
        '            color: black;\n' +
        '            font-size: 11px;\n' +
        '            font-weight: bold;\n' +
        '            padding: 0px 4px;\n' +
        '            border-radius: 3px;\n' +
        '            margin-left: 5px;\n' +
        '            vertical-align: middle;\n' +
        '        }\n' +
        '        \n' +
        '        /* Ready to merge badge */\n' +
        '        .merge-badge {\n' +
        '            display: inline-block;\n' +
        '            background-color: #4caf50;\n' +
        '            color: black;\n' +
        '            font-size: 11px;\n' +
        '            font-weight: bold;\n' +
        '            padding: 0px 4px;\n' +
        '            border-radius: 3px;\n' +
        '            margin-left: 5px;\n' +
        '            vertical-align: middle;\n' +
        '        }\n' +
        '        \n' +
        '        /* Draft PR badge */\n' +
        '        .draft-badge {\n' +
        '            display: inline-block;\n' +
        '            background-color: #1e90ff;\n' +
        '            color: white;\n' +
        '            font-size: 11px;\n' +
        '            font-weight: bold;\n' +
        '            padding: 0px 4px;\n' +
        '            border-radius: 3px;\n' +
        '            margin-right: 5px;\n' +
        '            vertical-align: middle;\n' +
        '        }\n' +
        '        \n' +
        '        /* Total PRs badge */\n' +
        '        .total-prs-badge {\n' +
        '            display: inline-block;\n' +
        '            color: #d4d4d4;\n' +
        '            font-size: 14px;\n' +
        '            margin-left: auto;\n' +
        '            margin-right: 15px;\n' +
        '        }\n' +
        '        \n' +
        '        /* Bigger pending count in main table */\n' +
        '        .pending-count {\n' +
        '            font-size: 18px;\n' +
        '            font-weight: bold;\n' +
        '            color: #ff9800;\n' +
        '        }\n' +
        '        \n' +
        '        /* PR count for authors */\n' +
        '        .pr-count {\n' +
        '            font-size: 18px;\n' +
        '            font-weight: bold;\n' +
        '            color: #1e90ff;\n' +
        '        }\n' +
        '        \n' +
        '        /* Ready to merge section header */\n' +
        '        .ready-section-header {\n' +
        '            background-color: rgba(76, 175, 80, 0.2);\n' +
        '            border-left: 4px solid #4caf50;\n' +
        '            padding: 10px 15px;\n' +
        '            margin-top: 30px;\n' +
        '            border-radius: 0 4px 4px 0;\n' +
        '            display: flex;\n' +
        '            justify-content: space-between;\n' +
        '            align-items: center;\n' +
        '        }\n' +
        '        .ready-section-header h2 {\n' +
        '            margin: 0;\n' +
        '            font-size: 20px;\n' +
        '            color: #4caf50;\n' +
        '        }\n' +
        '        .ready-count {\n' +
        '            background-color: #4caf50;\n' +
        '            color: white;\n' +
        '            font-size: 16px;\n' +
        '            font-weight: bold;\n' +
        '            padding: 2px 8px;\n' +
        '            border-radius: 12px;\n' +
        '        }\n' +
        '        \n' +
        '        /* Legend styles */\n' +
        '        .legend {\n' +
        '            margin-top: 10px;\n' +
        '            margin-bottom: 15px;\n' +
        '            padding: 15px;\n' +
        '            background-color: #1e1e1e;\n' +
        '            border-radius: 4px;\n' +
        '        }\n' +
        '        .legend h3 {\n' +
        '            margin-top: 0;\n' +
        '            border-bottom: 1px solid #444;\n' +
        '            padding-bottom: 8px;\n' +
        '        }\n' +
        '        .legend-item {\n' +
        '            margin-bottom: 12px;\n' +
        '        }\n' +
        '        .legend-item h4 {\n' +
        '            margin: 0 0 6px 0;\n' +
        '        }\n' +
        '        .legend-grid {\n' +
        '            display: flex;\n' +
        '            width: 100%;\n' +
        '            gap: 15px;\n' +
        '        }\n' +
        '        .legend-box {\n' +
        '            flex: 1;\n' +
        '            padding: 10px;\n' +
        '            background-color: rgba(255, 255, 255, 0.05);\n' +
        '            border-radius: 4px;\n' +
        '        }\n' +
        '        .legend-sample {\n' +
        '            display: inline-block;\n' +
        '            width: 20px;\n' +
        '            height: 12px;\n' +
        '            margin-right: 5px;\n' +
        '            vertical-align: middle;\n' +
        '        }\n' +
        '        .legend-table {\n' +
        '            width: 100%;\n' +
        '            margin-top: 10px;\n' +
        '            border-collapse: collapse;\n' +
        '        }\n' +
        '        .legend-table th, .legend-table td {\n' +
        '            padding: 5px 8px;\n' +
        '            text-align: left;\n' +
        '            border-bottom: 1px solid #333;\n' +
        '        }\n' +
        '        .legend-pending-sample {\n' +
        '            display: inline-block;\n' +
        '            border-left: 3px solid #ff9800;\n' +
        '            padding: 4px 8px;\n' +
        '            margin-bottom: 5px;\n' +
        '        }\n' +
        '        \n' +
        '        /* Bar chart styling */\n' +
        '        .chart-container {\n' +
        '            margin-top: 20px;\n' +
        '            margin-bottom: 30px;\n' +
        '            width: 100%;\n' +
        '            display: none;\n' +
        '            background-color: rgba(30, 30, 30, 0.5);\n' +
        '            padding: 20px;\n' +
        '            border-radius: 6px;\n' +
        '        }\n' +
        '        .chart-row {\n' +
        '            margin-bottom: 8px;\n' +
        '            display: flex;\n' +
        '            align-items: center;\n' +
        '        }\n' +
        '        .chart-label {\n' +
        '            width: 150px;\n' +
        '            text-align: right;\n' +
        '            padding-right: 10px;\n' +
        '            font-size: 14px;\n' +
        '            white-space: nowrap;\n' +
        '            overflow: hidden;\n' +
        '            text-overflow: ellipsis;\n' +
        '        }\n' +
        '        .chart-bar {\n' +
        '            height: 24px;\n' +
        '            background-color: #ff9800;\n' +
        '            border-radius: 3px;\n' +
        '            min-width: 2px;\n' +
        '            transition: width 0.5s ease-in-out;\n' +
        '            position: relative;\n' +
        '        }\n' +
        '        .author-chart-bar {\n' +
        '            background-color: #1e90ff; /* Different color for author charts */\n' +
        '        }\n' +
        '        .chart-value {\n' +
        '            position: absolute;\n' +
        '            right: -30px;\n' +
        '            top: 3px;\n' +
        '            font-weight: bold;\n' +
        '            color: #ff9800;\n' +
        '        }\n' +
        '        .author-chart-value {\n' +
        '            color: #1e90ff; /* Different color for author charts */\n' +
        '        }\n' +
        '        \n' +
        '        /* Navigation link styles */\n' +
        '        .nav-link {\n' +
        '            display: inline-block;\n' +
        '            background-color: #4caf50;\n' +
        '            color: white;\n' +
        '            padding: 5px 12px;\n' +
        '            border-radius: 4px;\n' +
        '            text-decoration: none;\n' +
        '            margin-left: 15px;\n' +
        '            font-weight: bold;\n' +
        '            transition: background-color 0.2s;\n' +
        '        }\n' +
        '        .nav-link:hover {\n' +
        '            background-color: #3d8b40;\n' +
        '        }\n' +
        '        \n' +
        '        /* Ready to Merge link style - no background, green text */\n' +
        '        .ready-link {\n' +
        '            display: inline-block;\n' +
        '            background-color: transparent; /* No background */\n' +
        '            color: #4caf50; /* Green text */\n' +
        '            padding: 5px 12px;\n' +
        '            text-decoration: none;\n' +
        '            margin-left: 15px;\n' +
        '            font-weight: bold;\n' +
        '        }\n' +
        '        .ready-link:hover {\n' +
        '            text-decoration: underline;\n' +
        '        }\n' +
        '        .back-to-top {\n' +
        '            display: inline-block;\n' +
        '            background-color: #333;\n' +
        '            color: white;\n' +
        '            padding: 5px 12px;\n' +
        '            border-radius: 4px;\n' +
        '            text-decoration: none;\n' +
        '            margin-left: 15px;\n' +
        '            font-size: 14px;\n' +
        '            transition: background-color 0.2s;\n' +
        '        }\n' +
        '        .back-to-top:hover {\n' +
        '            background-color: #555;\n' +
        '        }\n' +
        '    </style>\n' +
        '    <script>\n' +
        '        // Global variables for view state\n' +
        '        var currentView = \'reviewers\'; // \'reviewers\' or \'authors\'\n' +
        '        \n' +
        '        // Global data for charts\n' +
        '        var reviewerChartData = ' + JSON.stringify(reviewerChartData) + ';\n' +
        '        var authorData = ' + JSON.stringify(authors) + ';\n' +
        '        var authorNames = ' + JSON.stringify(authorNames) + ';\n' +
        '        var reviewerNames = ' + JSON.stringify(reviewerNames) + ';\n' +
        '        \n' +
        '        // Variable to track current sort order\n' +
        '        var sortAscending = false;\n' +
        '        \n' +
        '        // Function to get URL query parameters\n' +
        '        function getUrlParams() {\n' +
        '            var params = {};\n' +
        '            var queryString = window.location.search;\n' +
        '            \n' +
        '            if (queryString) {\n' +
        '                var urlParams = new URLSearchParams(queryString);\n' +
        '                urlParams.forEach(function(value, key) {\n' +
        '                    params[key] = value;\n' +
        '                });\n' +
        '            }\n' +
        '            return params;\n' +
        '        }\n' +
        '        \n' +
        '        // Enhanced filterTable function that updates the URL and applies filtering\n' +
        '        function filterTable(filterValue) {\n' +
        '            console.log("Filtering for:", filterValue);\n' +
        '            \n' +
        '            // Update the URL with the filter parameter if it\'s not \'all\'\n' +
        '            if (filterValue !== \'all\') {\n' +
        '                // Use replaceState to update URL without adding to browser history\n' +
        '                var newUrl = new URL(window.location.href);\n' +
        '                if (currentView === \'reviewers\') {\n' +
        '                    newUrl.searchParams.set(\'reviewer\', filterValue);\n' +
        '                    newUrl.searchParams.delete(\'author\');\n' +
        '                } else {\n' +
        '                    newUrl.searchParams.set(\'author\', filterValue);\n' +
        '                    newUrl.searchParams.delete(\'reviewer\');\n' +
        '                }\n' +
        '                window.history.replaceState({}, \'\', newUrl);\n' +
        '                console.log("Updated URL with filter param:", filterValue);\n' +
        '            } else {\n' +
        '                // Remove the filter parameters if \'all\' is selected\n' +
        '                var newUrl = new URL(window.location.href);\n' +
        '                if (currentView === \'reviewers\') {\n' +
        '                    newUrl.searchParams.delete(\'reviewer\');\n' +
        '                } else {\n' +
        '                    newUrl.searchParams.delete(\'author\');\n' +
        '                }\n' +
        '                window.history.replaceState({}, \'\', newUrl);\n' +
        '                console.log("Removed filter param from URL");\n' +
        '            }\n' +
        '            \n' +
        '            // Apply filtering to the table rows based on current view\n' +
        '            var rowSelector = currentView === \'reviewers\' ? \'.reviewer-row\' : \'.author-row\';\n' +
        '            var dataAttr = currentView === \'reviewers\' ? \'data-reviewer\' : \'data-author\';\n' +
        '            \n' +
        '            var rows = document.querySelectorAll(rowSelector);\n' +
        '            rows.forEach(function(row) {\n' +
        '                var shouldShow = (filterValue === \'all\' || \n' +
        '                    row.getAttribute(dataAttr).toLowerCase() === filterValue.toLowerCase());\n' +
        '                row.style.display = shouldShow ? \'\' : \'none\';\n' +
        '                console.log("Row:", row.getAttribute(dataAttr), \n' +
        '                    "Display:", shouldShow ? \'showing\' : \'hidden\');\n' +
        '            });\n' +
        '        }\n' +
        '        \n' +
        '        // Function to apply filter from URL if present (case-insensitive)\n' +
        '        function applyFilterFromUrl() {\n' +
        '            var params = getUrlParams();\n' +
        '            \n' +
        '            if (currentView === \'reviewers\' && params.reviewer) {\n' +
        '                var reviewerParam = params.reviewer.toLowerCase();\n' +
        '                console.log("Found reviewer param:", reviewerParam);\n' +
        '                \n' +
        '                // Find matching radio button (case-insensitive)\n' +
        '                var found = false;\n' +
        '                var filterRadios = document.querySelectorAll(\'input[name="reviewerFilter"]\');\n' +
        '                \n' +
        '                filterRadios.forEach(function(radio) {\n' +
        '                    if (radio.value.toLowerCase() === reviewerParam) {\n' +
        '                        console.log("Found radio button for reviewer:", radio.value);\n' +
        '                        // Select this radio button\n' +
        '                        radio.checked = true;\n' +
        '                        \n' +
        '                        // Apply the filter\n' +
        '                        filterTable(radio.value);\n' +
        '                        found = true;\n' +
        '                    }\n' +
        '                });\n' +
        '                \n' +
        '                if (!found) {\n' +
        '                    console.log("No matching reviewer found for:", reviewerParam);\n' +
        '                }\n' +
        '            } else if (currentView === \'authors\' && params.author) {\n' +
        '                var authorParam = params.author.toLowerCase();\n' +
        '                console.log("Found author param:", authorParam);\n' +
        '                \n' +
        '                // Find matching radio button (case-insensitive)\n' +
        '                var found = false;\n' +
        '                var filterRadios = document.querySelectorAll(\'input[name="authorFilter"]\');\n' +
        '                \n' +
        '                filterRadios.forEach(function(radio) {\n' +
        '                    if (radio.value.toLowerCase() === authorParam) {\n' +
        '                        console.log("Found radio button for author:", radio.value);\n' +
        '                        // Select this radio button\n' +
        '                        radio.checked = true;\n' +
        '                        \n' +
        '                        // Apply the filter\n' +
        '                        filterTable(radio.value);\n' +
        '                        found = true;\n' +
        '                    }\n' +
        '                });\n' +
        '                \n' +
        '                if (!found) {\n' +
        '                    console.log("No matching author found for:", authorParam);\n' +
        '                }\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        function filterByStatus(filterType) {\n' +
        '            // Hide chart if it\'s visible and we\'re switching to a non-chart filter\n' +
        '            if (filterType !== \'chart\') {\n' +
        '                var chartContainer = document.getElementById(\'chart-container\');\n' +
        '                var mainTable = currentView === \'reviewers\' ? \n' +
        '                                document.querySelector(\'.reviewer-table\') : \n' +
        '                                document.querySelector(\'.author-table\');\n' +
        '                var radioContainer = document.querySelector(\'.radio-container\');\n' +
        '                \n' +
        '                // Show the regular view\n' +
        '                chartContainer.style.display = \'none\';\n' +
        '                mainTable.style.display = \'table\';\n' +
        '                radioContainer.style.display = \'block\';\n' +
        '                \n' +
        '                // Show PR details\n' +
        '                var selector = currentView === \'reviewers\' ? \n' +
        '                               \'.reviewer-row.pr-row-table\' : \n' +
        '                               \'.author-row.pr-row-table\';\n' +
        '                var prRowTables = document.querySelectorAll(selector);\n' +
        '                prRowTables.forEach(function(prRowTable) {\n' +
        '                    prRowTable.classList.remove(\'hidden\');\n' +
        '                });\n' +
        '            }\n' +
        '            \n' +
        '            // For \'all\' (Report view), show all PRs with pending highlight for pending PRs\n' +
        '            if (filterType === \'all\') {\n' +
        '                var detailRows = document.querySelectorAll(\'tr.pr-detail-row\');\n' +
        '                detailRows.forEach(function(row) {\n' +
        '                    if (currentView === \'reviewers\') {\n' +
        '                        var isPending = row.hasAttribute(\'data-pending\') && \n' +
        '                            row.getAttribute(\'data-pending\') === \'true\';\n' +
        '                        if (isPending) {\n' +
        '                            row.classList.add(\'pending-review\');\n' +
        '                        } else {\n' +
        '                            row.classList.remove(\'pending-review\');\n' +
        '                        }\n' +
        '                    } else {\n' +
        '                        // In author view, we don\'t highlight pending rows\n' +
        '                        row.classList.remove(\'pending-review\');\n' +
        '                    }\n' +
        '                    row.style.display = \'\';\n' +
        '                });\n' +
        '                \n' +
        '                // Reapply the current filter\n' +
        '                var filterName = currentView === \'reviewers\' ? \n' +
        '                    \'reviewerFilter\' : \'authorFilter\';\n' +
        '                var selectedFilter = document.querySelector(\n' +
        '                    \'input[name="\' + filterName + \'"]:checked\').value;\n' +
        '                filterTable(selectedFilter);\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        function toggleDetails() {\n' +
        '            var chartRadio = document.getElementById(\'show-chart\');\n' +
        '            var chartContainer = document.getElementById(\'chart-container\');\n' +
        '            var mainTable = currentView === \'reviewers\' ? \n' +
        '                            document.querySelector(\'.reviewer-table\') : \n' +
        '                            document.querySelector(\'.author-table\');\n' +
        '            var selector = currentView === \'reviewers\' ? \n' +
        '                           \'.reviewer-row.pr-row-table\' : \n' +
        '                           \'.author-row.pr-row-table\';\n' +
        '            var prRowTables = document.querySelectorAll(selector);\n' +
        '            var radioContainer = document.querySelector(\'.radio-container\');\n' +
        '            \n' +
        '            // When chart mode is enabled\n' +
        '            if (chartRadio.checked) {\n' +
        '                // Show only the chart\n' +
        '                chartContainer.style.display = \'block\';\n' +
        '                mainTable.style.display = \'none\';\n' +
        '                radioContainer.style.display = \'none\';\n' +
        '                \n' +
        '                // Ensure PR details are hidden\n' +
        '                prRowTables.forEach(function(prRowTable) {\n' +
        '                    prRowTable.classList.add(\'hidden\');\n' +
        '                });\n' +
        '                \n' +
        '                // Draw the appropriate chart\n' +
        '                if (currentView === \'reviewers\') {\n' +
        '                    drawHorizontalChart(\'reviewers\');\n' +
        '                } else {\n' +
        '                    drawHorizontalChart(\'authors\');\n' +
        '                }\n' +
        '            } else {\n' +
        '                // Only option now is the "Report" view (all)\n' +
        '                filterByStatus(\'all\');\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        function toggleLegend() {\n' +
        '            var legend = document.getElementById(\'legend\');\n' +
        '            if (legend.classList.contains(\'hidden\')) {\n' +
        '                legend.classList.remove(\'hidden\');\n' +
        '                document.getElementById(\'toggleLegendBtn\').textContent = \'Hide Legend\';\n' +
        '            } else {\n' +
        '                legend.classList.add(\'hidden\');\n' +
        '                document.getElementById(\'toggleLegendBtn\').textContent = \'Show Legend\';\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        function switchView(view) {\n' +
        '            currentView = view;\n' +
        '            \n' +
        '            // Update active button styling\n' +
        '            document.querySelectorAll(\'.view-btn\').forEach(function(btn) {\n' +
        '                btn.classList.remove(\'active\');\n' +
        '            });\n' +
        '            document.getElementById(view + \'-view-btn\').classList.add(\'active\');\n' +
        '            \n' +
        '            // Show/hide the Ready to Merge elements based on the view\n' +
        '            var readyLink = document.getElementById(\'ready-to-merge-link\');\n' +
        '            var readySection = document.getElementById(\'ready-section\');\n' +
        '            var readyTable = document.getElementById(\'ready-table\');\n' +
        '            \n' +
        '            if (view === \'authors\') {\n' +
        '                // Show Ready to Merge elements in Authors\' view\n' +
        '                if (readyLink) readyLink.style.display = \'inline-block\';\n' +
        '                if (readySection) readySection.style.display = \'flex\';\n' +
        '                if (readyTable) readyTable.style.display = \'table\';\n' +
        '            } else {\n' +
        '                // Hide Ready to Merge elements in Reviewers\' view\n' +
        '                if (readyLink) readyLink.style.display = \'none\';\n' +
        '                if (readySection) readySection.style.display = \'none\';\n' +
        '                if (readyTable) readyTable.style.display = \'none\';\n' +
        '            }\n' +
        '            \n' +
        '            // Check if we\'re in chart mode\n' +
        '            var isChartMode = document.getElementById(\'show-chart\').checked;\n' +
        '            \n' +
        '            if (isChartMode) {\n' +
        '                // If in chart mode, just update the chart for the new view\n' +
        '                var chartContainer = document.getElementById(\'chart-container\');\n' +
        '                \n' +
        '                // Make sure chart is visible\n' +
        '                chartContainer.style.display = \'block\';\n' +
        '                \n' +
        '                // Hide all table views\n' +
        '                document.getElementById(\'reviewers-view\').classList.add(\'hidden\');\n' +
        '                document.getElementById(\'authors-view\').classList.add(\'hidden\');\n' +
        '                \n' +
        '                // Draw the appropriate chart for the new view\n' +
        '                if (view === \'reviewers\') {\n' +
        '                    drawHorizontalChart(\'reviewers\');\n' +
        '                } else {\n' +
        '                    drawHorizontalChart(\'authors\');\n' +
        '                }\n' +
        '            } else {\n' +
        '                // In table mode, switch the visible view\n' +
        '                // Hide all views\n' +
        '                document.getElementById(\'reviewers-view\').classList.add(\'hidden\');\n' +
        '                document.getElementById(\'authors-view\').classList.add(\'hidden\');\n' +
        '                \n' +
        '                // Show selected view\n' +
        '                document.getElementById(view + \'-view\').classList.remove(\'hidden\');\n' +
        '                \n' +
        '                // Apply filter from URL\n' +
        '                applyFilterFromUrl();\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        // Draw the horizontal bar chart\n' +
        '        function drawHorizontalChart(chartType) {\n' +
        '            var chartContainer = document.getElementById(\'horizontal-chart\');\n' +
        '            chartContainer.innerHTML = \'\'; // Clear existing content\n' +
        '            \n' +
        '            // Get chart data based on type\n' +
        '            var chartData;\n' +
        '            if (chartType === \'reviewers\') {\n' +
        '                chartData = reviewerChartData;\n' +
        '                document.querySelector(\'#chart-container h3\').textContent = \n' +
        '                    \'Pending Reviews by Reviewer\';\n' +
        '            } else {\n' +
        '                // For authors, we use author data\n' +
        '                chartData = [];\n' +
        '                // Convert author data to chart data format\n' +
        '                Object.entries(authorData).forEach(function(entry) {\n' +
        '                    var author = entry[0];\n' +
        '                    var data = entry[1];\n' +
        '                    if (data.count > 0) {\n' +
        '                        chartData.push({ author: author, count: data.count });\n' +
        '                    }\n' +
        '                });\n' +
        '                document.querySelector(\'#chart-container h3\').textContent = \n' +
        '                    \'Pull Requests by Author\';\n' +
        '            }\n' +
        '            \n' +
        '            // Sort data based on current sort direction\n' +
        '            if (sortAscending) {\n' +
        '                if (chartType === \'reviewers\') {\n' +
        '                    chartData.sort(function(a, b) { \n' +
        '                        return a.pending - b.pending; \n' +
        '                    }); // Ascending (lowest first)\n' +
        '                } else {\n' +
        '                    chartData.sort(function(a, b) { \n' +
        '                        return a.count - b.count; \n' +
        '                    }); // Ascending (lowest first)\n' +
        '                }\n' +
        '            } else {\n' +
        '                if (chartType === \'reviewers\') {\n' +
        '                    chartData.sort(function(a, b) { \n' +
        '                        return b.pending - a.pending; \n' +
        '                    }); // Descending (highest first)\n' +
        '                } else {\n' +
        '                    chartData.sort(function(a, b) { \n' +
        '                        return b.count - a.count; \n' +
        '                    }); // Descending (highest first)\n' +
        '                }\n' +
        '            }\n' +
        '            \n' +
        '            // Find the maximum value to calculate bar widths\n' +
        '            var maxValue = 0;\n' +
        '            chartData.forEach(function(item) {\n' +
        '                var val = chartType === \'reviewers\' ? item.pending : item.count;\n' +
        '                if (val > maxValue) maxValue = val;\n' +
        '            });\n' +
        '            var maxBarWidth = 800; // Maximum width for the bars in pixels\n' +
        '            \n' +
        '            // Create and append chart rows\n' +
        '            chartData.forEach(function(item) {\n' +
        '                var row = document.createElement(\'div\');\n' +
        '                row.className = \'chart-row\';\n' +
        '                \n' +
        '                var label = document.createElement(\'div\');\n' +
        '                label.className = \'chart-label\';\n' +
        '                \n' +
        '                var displayName;\n' +
        '                if (chartType === \'reviewers\') {\n' +
        '                    // Get the full name for reviewers if available\n' +
        '                    var fullName = reviewerNames[item.reviewer] || \'\';\n' +
        '                    displayName = fullName ? \n' +
        '                        fullName + \' (\' + item.reviewer + \')\' : item.reviewer;\n' +
        '                } else {\n' +
        '                    // Get the full name for authors if available\n' +
        '                    var fullName = authorNames[item.author] || \'\';\n' +
        '                    displayName = fullName ? \n' +
        '                        fullName + \' (\' + item.author + \')\' : item.author;\n' +
        '                }\n' +
        '                \n' +
        '                label.textContent = displayName;\n' +
        '                label.title = displayName; // Add tooltip for truncated names\n' +
        '                \n' +
        '                var barContainer = document.createElement(\'div\');\n' +
        '                barContainer.style.flex = \'1\';\n' +
        '                \n' +
        '                var bar = document.createElement(\'div\');\n' +
        '                bar.className = chartType === \'reviewers\' ? \n' +
        '                    \'chart-bar\' : \'chart-bar author-chart-bar\';\n' +
        '                var value = chartType === \'reviewers\' ? item.pending : item.count;\n' +
        '                var width = (value / maxValue) * maxBarWidth;\n' +
        '                bar.style.width = width + \'px\';\n' +
        '                \n' +
        '                var valueDisplay = document.createElement(\'div\');\n' +
        '                valueDisplay.className = chartType === \'reviewers\' ? \n' +
        '                    \'chart-value\' : \'chart-value author-chart-value\';\n' +
        '                valueDisplay.textContent = value;\n' +
        '                \n' +
        '                bar.appendChild(valueDisplay);\n' +
        '                barContainer.appendChild(bar);\n' +
        '                \n' +
        '                row.appendChild(label);\n' +
        '                row.appendChild(barContainer);\n' +
        '                \n' +
        '                chartContainer.appendChild(row);\n' +
        '            });\n' +
        '        }\n' +
        '        \n' +
        '        // Function to toggle sort order\n' +
        '        function toggleSortOrder() {\n' +
        '            sortAscending = !sortAscending;\n' +
        '            var toggleButton = document.getElementById(\'toggle-sort\');\n' +
        '            toggleButton.textContent = sortAscending ? \n' +
        '                \'Sort: Lowest First\' : \'Sort: Highest First\';\n' +
        '            \n' +
        '            if (currentView === \'reviewers\') {\n' +
        '                drawHorizontalChart(\'reviewers\');\n' +
        '            } else {\n' +
        '                drawHorizontalChart(\'authors\');\n' +
        '            }\n' +
        '        }\n' +
        '        \n' +
        '        document.addEventListener("DOMContentLoaded", function() {\n' +
        '            console.log("DOM content loaded");\n' +
        '            var lastUpdatedElement = document.getElementById("lastUpdated");\n' +
        '            var utcTimestamp = lastUpdatedElement.getAttribute("data-utc");\n' +
        '            if (utcTimestamp) {\n' +
        '                var localDate = new Date(utcTimestamp);\n' +
        '                lastUpdatedElement.textContent = "Last Updated: " + localDate.toLocaleString();\n' +
        '            }\n' +
        '            \n' +
        '            // Set default to show all PRs (report view)\n' +
        '            filterByStatus(\'all\');\n' +
        '            \n' +
        '            // Toggle Ready to Merge table visibility\n' +
        '            var toggleReadyBtn = document.getElementById(\'toggle-ready-btn\');\n' +
        '            var readyTable = document.getElementById(\'ready-table-section\');\n' +
        '            \n' +
        '            if (toggleReadyBtn && readyTable) {\n' +
        '                toggleReadyBtn.addEventListener(\'click\', function() {\n' +
        '                    if (readyTable.classList.contains(\'hidden\')) {\n' +
        '                        readyTable.classList.remove(\'hidden\');\n' +
        '                        toggleReadyBtn.textContent = \'Hide Ready to Merge PRs\';\n' +
        '                    } else {\n' +
        '                        readyTable.classList.add(\'hidden\');\n' +
        '                        toggleReadyBtn.textContent = \'Show Ready to Merge PRs\';\n' +
        '                    }\n' +
        '                });\n' +
        '            }\n' +
        '            \n' +
        '            // Add event listener for view selector buttons\n' +
        '            document.querySelectorAll(\'.view-btn\').forEach(function(btn) {\n' +
        '                btn.addEventListener(\'click\', function() {\n' +
        '                    switchView(this.getAttribute(\'data-view\'));\n' +
        '                });\n' +
        '            });\n' +
        '            \n' +
        '            // Set up sort toggle button\n' +
        '            var toggleButton = document.getElementById(\'toggle-sort\');\n' +
        '            toggleButton.addEventListener(\'click\', toggleSortOrder);\n' +
        '            \n' +
        '            // Add click handler for return to table button\n' +
        '            var returnButton = document.getElementById(\'return-to-table\');\n' +
        '            returnButton.addEventListener(\'click\', function() {\n' +
        '                document.getElementById(\'show-all-prs\').checked = true;\n' +
        '                // Switch to the current view first to make sure all tables are properly shown\n' +
        '                switchView(currentView);\n' +
        '                // Then apply the filter\n' +
        '                filterByStatus(\'all\');\n' +
        '            });\n' +
        '            \n' +
        '            // Always default to reviewers view first, regardless of URL parameters\n' +
        '            switchView(\'reviewers\');\n' +
        '            \n' +
        '            // Then check for params in URL and apply filter with a slight delay\n' +
        '            // to ensure all elements are properly initialized\n' +
        '            setTimeout(function() {\n' +
        '                var params = getUrlParams();\n' +
        '                // If we have author filter, switch to authors view\n' +
        '                if (params.author) {\n' +
        '                    switchView(\'authors\');\n' +
        '                }\n' +
        '                // Apply filters based on parameters\n' +
        '                applyFilterFromUrl();\n' +
        '            }, 200);\n' +
        '        });\n' +
        '    </script>\n' +
        '</head>';

    /** Page Title **/

    htmlContent += '  \n<body>\n' +
        '    <h2 id="top">\n' +
        '      <span class="repo-title">' + process.env.PROJECT_OWNER + '/' +
        process.env.PROJECT_NAME + '</span> Open Pull Requests\n' +
        '      <span id="lastUpdated" class="last-updated" data-utc="' + lastUpdatedUTC + '"></span>\n' +
        '    </h2>\n' +
        '    \n' +
        '    <!-- View selector -->\n' +
        '    <div class="view-controls">\n' +
        '        <div class="view-selector">\n' +
        '            <button id="reviewers-view-btn" class="view-btn active" ' +
        'data-view="reviewers">Reviewers\' View</button>\n' +
        '            <button id="authors-view-btn" class="view-btn" ' +
        'data-view="authors">Authors\' View</button>\n' +
        '        </div>\n' +
        '    </div>\n' +
        '    \n' +
        '    <div class="filter-controls">\n' +
        '        <div>\n' +
        '            <label><input type="radio" name="prFilter" id="show-all-prs" ' +
        'onclick="filterByStatus(\'all\')" checked> Report</label>\n' +
        '            <label><input type="radio" name="prFilter" id="show-chart" ' +
        'onClick="toggleDetails()"> Chart</label>\n' +
        '            ' + (readyToMergePRs.length > 0 ?
            '<a href="#ready-section" class="ready-link" id="ready-to-merge-link" style="display: none;">Ready To Merge (' +
            readyToMergePRs.length + ')</a>' : '') + '\n' +
        '        </div>\n' +
        '        <span class="total-prs-badge">Total # Of Open PRs: ' + totalOpenPRs + '</span>\n' +
        '        <button id="toggleLegendBtn" onClick="toggleLegend()" ' +
        'style="margin-left: 15px; background-color: #333; color: white; border: none; ' +
        'padding: 5px 10px; cursor: pointer; border-radius: 4px;">Show Legend</button>\n' +
        '    </div>\n' +
        '    <!-- Empty row for spacing -->\n' +
        '    <div style="height: 15px;"></div>\n' +
        '    \n' +
        '    <!-- Legend positioned between filters and radio buttons -->\n' +
        '    <div id="legend" class="legend hidden">\n' +
        '      <h3>Pull Request Review Report Legend</h3>\n' +
        '      \n' +
        '      <div class="legend-grid">\n' +
        '        <div class="legend-box">\n' +
        '          <h4>Pull Request Status</h4>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="legend-sample" style="background-color: #ff9800;"></span>\n' +
        '            <span class="needs-review">Needs Review</span>: ' +
        'Pull Request needs more reviews before it can be merged\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="legend-sample" style="background-color: #f44336;"></span>\n' +
        '            <span class="changes-requested">Changes Requested</span>: ' +
        'Pull Request needs code changes based on review feedback\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="legend-sample" style="background-color: #4caf50;"></span>\n' +
        '            <span class="ready-to-merge">Ready to Merge</span>: ' +
        'Pull Request has all required approvals (' + REQUIRED_APPROVALS + ') and can be merged\n' +
        '          </div>\n' +
        '        </div>\n' +
        '        \n' +
        '        <div class="legend-box">\n' +
        '          <h4>Reviewer Status</h4>\n' +
        '          <table class="legend-table">\n' +
        '            <tr>\n' +
        '              <th>Status</th>\n' +
        '              <th>Description</th>\n' +
        '            </tr>\n' +
        '            <tr>\n' +
        '              <td><code>username (requested)</code></td>\n' +
        '              <td>Reviewer has been requested but hasn\'t reviewed yet</td>\n' +
        '            </tr>\n' +
        '            <tr>\n' +
        '              <td><code>username (approved)</code></td>\n' +
        '              <td>Reviewer has approved the Pull Request</td>\n' +
        '            </tr>\n' +
        '            <tr>\n' +
        '              <td><code>username (commented)</code></td>\n' +
        '              <td>Reviewer has commented but not approved or requested changes</td>\n' +
        '            </tr>\n' +
        '            <tr>\n' +
        '              <td><code>username (requested changes)</code></td>\n' +
        '              <td>Reviewer has requested changes that need to be addressed</td>\n' +
        '            </tr>\n' +
        '            <tr>\n' +
        '              <td><code>username (pending)</code></td>\n' +
        '              <td>Started but not submitted review: When a reviewer begins drafting ' +
        'their review in GitHub but hasn\'t submitted it yet</td>\n' +
        '            </tr>\n' +
        '          </table>\n' +
        '        </div>\n' +
        '        \n' +
        '        <div class="legend-box">\n' +
        '          <h4>Visual Indicators & Views</h4>\n' +
        '          <div class="legend-item">\n' +
        '            <div class="legend-pending-sample">Pull Request requiring your review</div>\n' +
        '            Pull Requests that need your review are highlighted with ' +
        'an orange left border in Reviewers\' View\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="pending-badge">3</span> The number in the orange badge ' +
        'shows how many pending reviews in Reviewers\' View\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="author-badge">4</span> The number in the blue badge ' +
        'shows how many PRs created in Authors\' View\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span class="draft-badge">DRAFT</span> Indicates a pull request in draft state that is not ready for review\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <span style="color: yellow;">Yellow</span> / ' +
        '<span style="color: orange;">Orange</span> / ' +
        '<span style="color: red;">Red</span> days count: ' +
        'Indicates how long the Pull Request has been open\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <strong>Reviewers\' View</strong>: Focus on PRs that each reviewer ' +
        'is responsible for reviewing\n' +
        '          </div>\n' +
        '          <div class="legend-item">\n' +
        '            <strong>Authors\' View</strong>: Focus on PRs created by each author\n' +
        '          </div>\n' +
        '        </div>\n' +
        '      </div>\n' +
        '    </div>\n' +
        '    \n' +
        '    <!-- Bar chart container -->\n' +
        '    <div id="chart-container" class="chart-container">\n' +
        '        <h3>\n' +
        '            Pending Reviews by Reviewer\n' +
        '            <button id="toggle-sort" style="margin-left: 10px; background-color: #333; ' +
        'color: white; border: none; padding: 5px 10px; cursor: pointer; ' +
        'border-radius: 4px; font-size: 12px;">\n' +
        '                Sort: Highest First\n' +
        '            </button>\n' +
        '            <button id="return-to-table" style="margin-left: 10px; background-color: #555; ' +
        'color: white; border: none; padding: 5px 10px; cursor: pointer; ' +
        'border-radius: 4px; font-size: 12px;">\n' +
        '                Back to Table View\n' +
        '            </button>\n' +
        '        </h3>\n' +
        '        <div id="horizontal-chart"></div>\n' +
        '    </div>';

    /* REVIEWERS VIEW */
    htmlContent += '<div id="reviewers-view">\n' +
        '        <div class="radio-container">\n' +
        '            <label><input type="radio" name="reviewerFilter" value="all" checked ' +
        'onclick="filterTable(\'all\')"> Show all</label>\n' +
        '            <table style="margin-top: 8px; margin-bottom: 24px;">\n' +
        '                <tr>'; // Start the first row

    let count = 0;
    Object.keys(reviewers).forEach((reviewer) => {
        if (count % 4 === 0 && count !== 0) {
            htmlContent += '</tr><tr>'; // Close the previous row and start a new one every 4 items
        }

        const pendingCount = reviewers[reviewer].pending;
        // Get the full name for the reviewer, default to empty string if not available
        const fullName = reviewerNames[reviewer] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? fullName + ' (' + reviewer + ')' : reviewer;

        // Pending badge
        const pendingBadge = pendingCount > 0 ?
            '<span class="pending-badge">' + pendingCount + '</span>' : '';

        htmlContent += '<td style="text-align: left; padding: 2px;">\n' +
            '        <label><input type="radio" name="reviewerFilter" value="' + reviewer + '" ' +
            'onclick="filterTable(\'' + reviewer + '\')"> ' + displayName + ' ' + pendingBadge + '</label>\n' +
            '    </td>';
        count++;
    });
    // Close the last row
    htmlContent += '</tr></table>\n' +
        '        </div>\n' +
        '        <table class="reviewer-table">\n' +
        '            <tr>\n' +
        '                <th style="width: 28%;">Reviewer</th>\n' +
        '                <th># Reviews Requested (Pending)</th>\n' +
        '            </tr>';

    // Reviewer's PR Table with full names
    Object.entries(reviewers).forEach(([reviewer, data]) => {
        // Get the full name for the reviewer, default to empty string if not available
        const fullName = reviewerNames[reviewer] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? fullName + ' (' + reviewer + ')' : reviewer;

        htmlContent += '<tr class="reviewer-row" data-reviewer="' + reviewer + '">\n' +
            '        <td>' + displayName + '</td>\n' +
            '        <td><span class="pending-count">' + data.pending + '</span></td>\n' +
            '    </tr>\n  \n' +
            '    <tr class="reviewer-row pr-row-table" data-reviewer="' + reviewer + '">\n' +
            '        <td colspan="2">\n' +
            '            <table class="pr-table reviewer-pr-table">\n' +
            '                <tr>\n' +
            '                  <th title="Pull Request">Pull Request</th>\n' +
            '                  <th title="Author">Author</th>\n' +
            '                  <th title="Jira">Jira</th>\n' +
            '                  <th title="Reviewers">Reviewers</th>\n' +
            '                  <th title="# Days Open"># Days Open</th>\n' +
            '                  <th title="# Approvals"># Approvals</th>\n' +
            '                  <th title="Status">Status</th>\n' +
            '                </tr>';

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
            htmlContent += '<tr class="pr-detail-row" data-status="' + pr.status + '" ' +
                'data-pending="' + pr.isPending + '">\n' +
                '              <td><a title="' + pr.title + '" class="pr-link" \n' +
                '                     href="https://github.com/' + process.env.PROJECT_OWNER + '/' +
                process.env.PROJECT_NAME + '/pull/' + pr.number + '">' + pr.title +
                '                  </a>\n' +
                '              </td>\n' +
                '              <td title="' + pr.author + '">' + pr.author + '</td>\n' +
                '              <td title="Jira IDs">' + pr.jiraLinks + '</td>\n' +
                '              <td title="' + pr.reviewers + '">' +
                (pr.isDraft ? '<div class="draft-badge">DRAFT</div>' : '') +
                reviewersList + '</td>\n' +
                '              <td title="' + pr.daysOpen + '" style="color: ' +
                pr.daysOpenColor + ';">' + pr.daysOpen + '</td>\n' +
                '              <td title="' + pr.approvals + '">' + pr.approvals + '/' +
                REQUIRED_APPROVALS + '</td>\n' +
                '              <td class="' + statusClass + '" title="' + statusText + '">' +
                statusText + '</td>\n' +
                '            </tr>';
        });

        htmlContent += '</table>\n        </td>\n    </tr>';
    });

    htmlContent += '</table>\n    </div>'; // End of reviewers view

    /* AUTHORS VIEW */
    htmlContent += '<div id="authors-view" class="hidden">\n' +
        '        <div class="radio-container">\n' +
        '            <label><input type="radio" name="authorFilter" value="all" checked ' +
        'onclick="filterTable(\'all\')"> Show all</label>\n' +
        '            <table style="margin-top: 8px; margin-bottom: 24px;">\n' +
        '                <tr>'; // Start the first row

    count = 0;
    Object.keys(authors).forEach((author) => {
        if (count % 4 === 0 && count !== 0) {
            htmlContent += '</tr><tr>'; // Close the previous row and start a new one every 4 items
        }

        const prCount = authors[author].count;
        // Get the full name for the author, default to empty string if not available
        const fullName = authorNames[author] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? fullName + ' (' + author + ')' : author;

        // Add blue author badge similar to the orange pending badge for reviewers
        const authorBadge = '<span class="author-badge">' + prCount + '</span>';

        htmlContent += '<td style="text-align: left; padding: 2px;">\n' +
            '        <label><input type="radio" name="authorFilter" value="' + author + '" ' +
            'onclick="filterTable(\'' + author + '\')"> ' + displayName + ' ' + authorBadge + '</label>\n' +
            '    </td>';
        count++;
    });
    // Close the last row
    htmlContent += '</tr></table>\n' +
        '        </div>\n' +
        '        <table class="author-table">\n' +
        '            <tr>\n' +
        '                <th style="width: 28%;">Author</th>\n' +
        '                <th># PRs Created</th>\n' +
        '            </tr>';

    // Author's PR Table with full names
    Object.entries(authors).forEach(([author, data]) => {
        // Get the full name for the author, default to empty string if not available
        const fullName = authorNames[author] || '';

        // Format as "Full Name (username)" if full name exists, otherwise just username
        const displayName = fullName ? fullName + ' (' + author + ')' : author;

        htmlContent += '<tr class="author-row" data-author="' + author + '">\n' +
            '        <td>' + displayName + '</td>\n' +
            '        <td><span class="pr-count">' + data.count + '</span></td>\n' +
            '    </tr>\n  \n' +
            '    <tr class="author-row pr-row-table" data-author="' + author + '">\n' +
            '        <td colspan="2">\n' +
            '            <table class="pr-table author-pr-table">\n' +
            '                <tr>\n' +
            '                  <th title="Pull Request">Pull Request</th>\n' +
            '                  <th title="Jira">Jira</th>\n' +
            '                  <th title="Reviewers">Reviewers</th>\n' +
            '                  <th title="# Days Open"># Days Open</th>\n' +
            '                  <th title="# Approvals"># Approvals</th>\n' +
            '                  <th title="Status">Status</th>\n' +
            '                </tr>';

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

            htmlContent += '<tr class="pr-detail-row" data-status="' + pr.status + '">\n' +
                '              <td><a title="' + pr.title + '" class="pr-link" \n' +
                '                     href="https://github.com/' + process.env.PROJECT_OWNER + '/' +
                process.env.PROJECT_NAME + '/pull/' + pr.number + '">' + pr.title +
                '                  </a>\n' +
                '              </td>\n' +
                '              <td title="Jira IDs">' + pr.jiraLinks + '</td>\n' +
                '              <td title="' + pr.reviewers + '">' +
                (pr.isDraft ? '<div class="draft-badge">DRAFT</div>' : '') +
                pr.reviewers + '</td>\n' +
                '              <td title="' + pr.daysOpen + '" style="color: ' +
                pr.daysOpenColor + ';">' + pr.daysOpen + '</td>\n' +
                '              <td title="' + pr.approvals + '">' + pr.approvals + '/' +
                REQUIRED_APPROVALS + '</td>\n' +
                '              <td class="' + statusClass + '" title="' + statusText + '">' +
                statusText + '</td>\n' +
                '            </tr>';
        });

        htmlContent += '</table>\n        </td>\n    </tr>';
    });

    htmlContent += '</table>\n    </div>'; // End of authors view

    /* READY TO MERGE SECTION */
    htmlContent += '\n    <!-- Ready to Merge PRs Section -->\n' +
        '    <div id="ready-section" class="ready-section-header" style="display: none;">\n' +
        '        <h2>Ready to Merge Pull Requests</h2>\n' +
        '        <div>\n' +
        '            <span class="ready-count">' + readyToMergePRs.length + '</span>\n' +
        '            <a href="#top" class="back-to-top">Back to top</a>\n' +
        '        </div>\n' +
        '    </div>\n' +
        '    \n' +
        '    <table class="ready-table" id="ready-table" style="display: none;">\n' +
        '        <tr>\n' +
        '            <th>Pull Request</th>\n' +
        '            <th>Author</th>\n' +
        '            <th>Days Open</th>\n' +
        '            <th>Approvals</th>\n' +
        '            <th>Approved By</th>\n' +
        '            <th>Jira</th>\n' +
        '        </tr>';

    // Sort ready to merge PRs by days open (newest first)
    readyToMergePRs.sort((a, b) => b.daysOpen - a.daysOpen);

    readyToMergePRs.forEach(pr => {
        htmlContent += '\n        <tr>\n' +
            '            <td><a title="' + pr.title + '" class="pr-link" \n' +
            '                 href="https://github.com/' + process.env.PROJECT_OWNER + '/' +
            process.env.PROJECT_NAME + '/pull/' + pr.number + '">' + pr.title +
            (pr.isDraft ? ' <div class="draft-badge">DRAFT</div>' : '') + '</a></td>\n' +
            '            <td>' + pr.author + '</td>\n' +
            '            <td style="color: ' + pr.daysOpenColor + ';">' + pr.daysOpen + '</td>\n' +
            '            <td>' + pr.approvals + '/' + pr.requiredApprovals + '</td>\n' +
            '            <td title="' + pr.approvedBy + '">' + pr.approvedBy + '</td>\n' +
            '            <td title="Jira IDs">' + pr.jiraLinks + '</td>\n' +
            '        </tr>';
    });

    // Add message for no PRs ready to merge
    if (readyToMergePRs.length === 0) {
        htmlContent += '\n        <tr>\n' +
            '            <td colspan="6" style="text-align: center; padding: 20px;">\n' +
            '                No pull requests are currently ready to merge.\n' +
            '            </td>\n' +
            '        </tr>';
    }

    htmlContent += '</table>\n</body>\n</html>';

    const path = require('path');
    const outputDir = './webpage';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outputDir, 'index.html'), htmlContent, 'utf8');
}