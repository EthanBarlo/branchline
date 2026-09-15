# Branchline 0.11.0

Review and merge a whole Bitbucket branch across your project and its submodules, with Jira ticket context beside the code.

- Connect separate Jira and Bitbucket accounts in the new settings sections, with token-generation links and permission guidance.
- Discover open Bitbucket pull requests and include matching branch changes from every mapped repository, including repositories without a PR. Branchline creates missing PRs when you publish feedback or approve and merge.
- Start reviewing as soon as each repository finishes loading. Repository checks and downloads run concurrently, with visible progress while the rest load.
- Publish feedback directly to Bitbucket files, lines and ranges. Edits, resolutions and deletions sync through Publish feedback, with conflict handling and recovery for uncertain deliveries.
- Approve, merge and clean up branches across repositories, including empty branches. Independent operations run up to four at a time, with per-repository status and resumable results.
- Optionally update parent submodule pointers using the actual child merge commits, pausing for review before parent merges.
- View Jira ticket titles and descriptions in the review, and open Jira to update ticket status after merging.
- Move between reviewed files immediately. Remote reviews use cached snapshots; Current reviews scan in the background while comments and review markers save.
- Keep compact diffs and scroll position when adding comments, open PRs after publishing feedback, and automatically close successfully merged reviews.

Bitbucket tokens need `read:user:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`. If branch cleanup is unavailable with an existing token, replace it using the guidance in Settings → Bitbucket.
