# Branchline 0.16.0

This release makes reviews, pull request lists and Approve and merge much faster, and fixes a Current review that could leave out a repository's changes.

- **Current review includes every repository again**

  A large untracked folder, such as a `node_modules` folder left behind by another branch, could make the Current review drop a repository's changes without saying so. Branchline now leaves out any untracked folder with more than 1,000 files and shows a notice naming it, so the rest of the repository's changes appear as expected.

- **Current review builds in about a second**

  Because large untracked folders are no longer read file by file, a review that took about 30 seconds to gather your changes now takes about a second. When you come back to a review, Branchline shows its last result at once and refreshes it in the background. Approvals and comments are still checked against a fresh comparison.

- **Open pull requests and reviews faster**

  The pull request list shows the last list straight away while it refreshes, and loads its pull requests in parallel. Opening a review makes fewer requests to Bitbucket.

- **Load multi-repository reviews sooner**

  Branchline checks every repository in a Bitbucket review at the same time, and each repository's files start loading as soon as its own checks finish. A review across five repositories loads in about a third of the time.

- **Approve and merge with fewer waits**

  Approve and merge reuses the checks it has just made instead of repeating them, and branch cleanup checks everything it needs at once. The dialog's check before merging and the merge itself each make about half as many back-and-forth calls to Bitbucket. Every merge and branch deletion is still checked first.

- The merge dialog and the repository loading list show moving spinners while they work.

The universal macOS build supports Intel and Apple Silicon. Your existing reviews, connections, and settings stay in place.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.15.0...v0.16.0
