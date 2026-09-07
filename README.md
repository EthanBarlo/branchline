# Branchline

A local desktop code review app for repositories with Git submodules. Review matching branches across the whole checkout, leave inline comments, and copy the feedback as one message.

## Run

Requires Node.js 22.12+ and Git installed on your machine.

```sh
npm install
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

`npm run package` produces an unpacked desktop application in `release/`. `npm run dist` produces an installer for the current platform. macOS distribution builds are unsigned unless you configure your own signing identity.

## Review workflow

1. Add a project by choosing the top-level local repository once. Each project gets a top tab and a permanent **Current** review.
2. Choose the target branch in Current. It starts unset and is remembered for that project. Current follows the checked-out branch automatically, so you can keep using it without creating reviews.
3. Current includes tracked edits, staged edits, and nonignored new files when each repository has the matching feature branch revision checked out. Use the **+** beside the review selector to review another branch; saved reviews default to committed changes only.
4. Browse the combined file tree, choose split or unified diffs, and click a line number or select a range to leave a comment. Comments save as you type; click away to finish editing, or click saved text to edit it. The compact actions let you delete, resolve, or reopen a comment.
5. Mark each file reviewed to open the next unreviewed file in explorer order, skipping completed files and wrapping around when needed. Right-click a file for review actions, or Shift-click a range and mark the selection together; Cmd/Ctrl-click toggles individual files. Batch approval checks every selected file version before saving. When no files remain, the review shows that you’re all caught up. The default **Unreviewed** filter hides it from the tree. If its before/after contents, path, or file mode change, its approval clears on refresh and it returns with a **Changed** label. **All files** shows reviewed files too. Unrelated commits preserve approvals.
6. Click **Copy feedback** to copy all unresolved comments, grouped by file and ordered by line. Each entry contains only its repository-relative path and line reference, followed by the comment.

Create as many projects and saved reviews as you need. Projects remember their repository location and Current target independently. Rename or remove projects from project settings; removing a project removes its reviews and feedback, never the repository files. Projects, reviews, comments, and approvals persist between launches. Existing saved reviews keep their feedback during migration, and each project gains a Current review with an unset target.

Project tabs share the window's title bar. The compact toolbar below contains the review selector, branch comparison, feedback, and copy controls. The file-tree button hides or shows the file pane. Drag its right edge to resize it, or focus the divider and use the arrow keys. Pane width, visibility, and file filter are remembered. Open the **…** workspace menu for project settings, repository details, help, or deleting a saved review.

Branch and review pickers open an in-app list with a search field. Type to filter, use the arrow keys and Enter to choose, or Escape to dismiss without changing the selection. Reopening a picker shows the full list, including when a branch is already selected.

Current keeps feedback separately for each branch-and-target comparison. Switching branches or targets changes the active feedback; returning restores the previous comments and any approvals that still match the files. A detached HEAD pauses Current until a branch is checked out. Saved reviews stay tied to their explicit feature branch. The selected review refreshes every four seconds while the window is visible and on returning to it; manual refresh is also available.

## Jira tickets

Open **Settings** from the top-right settings button and enter your **Jira base URL**, such as `https://your-team.atlassian.net` or `https://jira.example.com/jira`. The setting is saved locally and applies to all projects. Use the site address before `/browse`, as described in [Atlassian’s site URL guide](https://support.atlassian.com/jira/kb/find-your-site-url-to-set-up-the-jira-data-center-and-server-mobile-app/).

When a branch contains a ticket key, such as `feature/APP-123-add-search`, an **APP-123 ↗** button appears beside it. Click to open the ticket in your default browser. Lowercase keys are normalized to uppercase; if a branch contains multiple keys, the first matching key is used. Current uses the latest checked-out branch, while saved reviews use their feature branch. Branches without a ticket key have no ticket button. If Jira has not been configured, the button opens Settings. Clear the base URL to remove the configuration.

## Comparison semantics

Each repository is compared from `merge-base(target, feature)` to the feature revision (or its current working contents when eligible). This is the meaning of `git diff target...feature` for committed changes. Target-only commits do not appear as feature changes.

Submodules use matching branch names, independently of the parent repository's recorded submodule commit. Local branches are preferred; available remote-tracking branches are supported. Branchline reads local Git data and never fetches, checks out, stages, commits, or updates submodules. Fetch or initialize submodules yourself when needed. Missing branches, uninitialized submodules, unresolved working-tree conflicts, and ambiguous merge bases produce visible notices.

## Live changes and comments

An approval belongs to the exact before/after file version. Observing a new version clears it, even if the file later returns to its previous contents. Changes that happen and revert entirely between refreshes cannot be detected.

Existing comments retain their original side, line range, code context, and content fingerprint. When a file changes, earlier feedback stays inline near the code it referred to, following line edits and saved surrounding context. If the exact code was removed or rewritten, it stays near the previous location. Open the compact earlier-version details to see its original context. File comments and comments without a text preview appear above the file notice.

Pending comments are saved before switching files or reviews, copying feedback, or closing the app. Edits also have a local recovery copy scoped to their project, review, branch comparison, and file. If saving fails, the editor shows the error and retains the text for retrying.

## Local storage and boundaries

The Electron main process runs read-only Git commands and persists projects and reviews in `reviews.json` under Electron's user-data directory (on macOS, normally `~/Library/Application Support/Branchline/`). The renderer has an isolated, sandboxed preload bridge. Code is rendered locally with `@pierre/diffs` and file navigation uses `@pierre/trees`.

Binary files and files above 1 MiB show a metadata view and can be marked reviewed; inline text comments require a rendered text diff. Symlinks are reviewed as link targets without opening their destinations. Removed submodule pointers are reported as notices. Git must already be available locally. There is no account, hosted service, or automatic network fetch.

## Verify

```sh
npm test
npm run build
npm run test:desktop
npm run test:desktop:jira
```

The unit/integration tests create temporary Git repositories to exercise divergent targets, working contents, recursive submodules, missing refs, renames, binary/large files, symlinks, approval invalidation, persistence, and export. The desktop smoke test launches the real Electron app with a temporary repository and isolated user data, exercises the UI and clipboard, edits a file externally, checks automatic invalidation, and reopens the app to verify persistence. Screenshots are saved under `artifacts/`.

The Jira desktop check covers settings, branch detection, and persistence using isolated test data. It intercepts browser opening to verify the destination without visiting Jira.
