# Branchline 0.15.0

This release runs Git actions without a confirmation step, lets you push any local branch, and makes pushing and publishing feedback faster across repositories.

- **Run Git actions without a confirmation step**

  Fetch, pull, push, check out, create, and rename start as soon as their checks pass. A toast follows each action with a progress bar, then shows the result. If an action is blocked, the toast says why and offers **Details**. Deleting a branch still asks you to confirm.

- **Push any local branch**

  Push a branch from its right-click menu whether or not it is checked out, even before it has new commits. Repositories without that branch are skipped. When a push would create a branch on the remote, Branchline asks you to confirm first. In a project with submodules, each repository has a checkbox, so you can leave one out of the push.

- **Push across repositories faster**

  Branchline checks each repository as soon as its own fetch finishes, and a parent repository waits only for the submodules that have commits to publish. Up to eight repositories use the network at once. A push never overwrites remote commits that arrived after its checks.

- **Request changes when you publish feedback**

  Publishing feedback can mark each pull request that receives new or edited comments as changes requested in Bitbucket. This replaces your approval on that pull request. The **Request changes on the pull request** checkbox in the publish dialog controls it and is on by default. The publish dialog also opens faster, because it no longer reloads the whole review first.

- **Keep resolved comments out of the way**

  A resolved comment shrinks to a small marker on its line. Hover over or focus the marker to read the comment, reopen it, or delete it. Open comments show their line reference, an **Earlier version** badge that reveals the saved code, and their actions on hover. The Feedback panel uses the same design.

- **See which file you are reading**

  As you scroll through a review, the file tree highlights the file shown in the diff.

- **Arrange your projects**

  Drag a project tab to reorder it. Right-click a tab to rename it, move it left or right, or remove the project.

- The Git results panel appears only when a result is uncertain and needs checking.
- **Also delete remote branch** appears only when the branch has a remote copy.

The universal macOS build supports Intel and Apple Silicon. Your existing reviews, connections, and settings stay in place.

**Full changelog:** https://github.com/EthanBarlo/branchline/compare/v0.14.0...v0.15.0
