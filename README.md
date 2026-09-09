# Branchline

A desktop code review app for repositories with Git submodules. Review local branches or grouped Bitbucket Cloud PRs, read Jira context alongside the diff, and keep feedback local or publish it inline.

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

`npm run package` produces an unpacked desktop application in `release/`. `npm run dist` produces installers; macOS builds include a universal DMG and ZIP for Intel and Apple Silicon. Local builds are unsigned unless you configure signing. The release workflow requires Developer ID signing and notarization.

## App updates

Installed macOS builds check GitHub Releases shortly after startup and every six hours, including when you return after a check becomes overdue. **Updates** beside the app name opens the update dialog; **Check for Updates…** is also in the native application menu. Download when convenient, continue reviewing while it downloads, then choose **Restart to update**. Branchline saves pending comments and finishes accepted review writes before restarting. Saving failures leave the workspace open for retry. Choosing **Later**, closing the dialog or quitting normally does not install an update.

The first signed build containing the updater must be installed manually. Later stable releases can update in-app. Development builds, Windows and Linux do not run update checks. See [release setup and Apple credentials](docs/releases.md) for GitHub Actions secret names, draft releases and signed update testing.

## Review workflow

1. Add a project by choosing the top-level local repository once. Each project gets a top tab and a permanent **Current** review.
2. Choose the target branch in Current. It starts unset and is remembered for that project. Current follows the checked-out branch automatically, so you can keep using it without creating reviews.
3. Current includes tracked edits, staged edits, and nonignored new files when each repository has the matching feature branch revision checked out. Use the **+** beside the review selector to review another branch; saved reviews default to committed changes only.
4. Browse the combined file tree, choose split or unified diffs, and click a line number or select a range to leave a comment. Comments save as you type; click away to finish editing, or click saved text to edit it. The compact actions let you delete, resolve, or reopen a comment.
5. Mark each file reviewed to open the next unreviewed file in explorer order, skipping completed files and wrapping around when needed. Markers describe the cached file version you reviewed and save without waiting for a full repository scan. Right-click a file for review actions, or Shift-click a range and mark the selection together; Cmd/Ctrl-click toggles individual files. Batch approval validates every selected version against the loaded snapshot before saving. When no files remain, the review shows that you’re all caught up. The default **Unreviewed** filter hides it from the tree. If its before/after contents, path, or file mode change, its approval clears on refresh and it returns with a **Changed** label. **All files** shows reviewed files too. Unrelated commits preserve approvals.
6. Click **Copy feedback** to copy all unresolved comments, grouped by file and ordered by line. Each entry contains only its repository-relative path and line reference, followed by the comment.

Create as many projects and saved reviews as you need. Projects remember their repository location and Current target independently. Rename or remove projects from project settings; removing a project removes its reviews and feedback, never the repository files. Projects, reviews, comments, and approvals persist between launches. Existing saved reviews keep their feedback during migration, and each project gains a Current review with an unset target.

Project tabs share the window's title bar. The compact toolbar below contains the review selector, branch comparison, feedback, and copy controls. The file-tree button hides or shows the file pane. Drag its right edge to resize it, or focus the divider and use the arrow keys. Pane width, visibility, and file filter are remembered. Open the **…** workspace menu for project settings, repository details, help, or deleting a saved review.

Branch and review pickers open an in-app list with a search field. Type to filter, use the arrow keys and Enter to choose, or Escape to dismiss without changing the selection. Reopening a picker shows the full list, including when a branch is already selected.

Current keeps feedback separately for each branch-and-target comparison. Switching branches or targets changes the active feedback; returning restores the previous comments and any approvals that still match the files. A detached HEAD pauses Current until a branch is checked out. Saved reviews stay tied to their explicit feature branch. The selected local review refreshes in the background every four seconds while the window is visible and on returning to it; manual refresh is also available. A running scan does not block marking files reviewed or saving comments. Lightweight checkout checks protect feedback from branch switches, and stale scan results cannot replace a newer branch or target comparison.

## Jira tickets

Open **Settings** from the top-right settings button. Settings is a full workspace with **Jira**, **Bitbucket**, **Updates** and **Diagnostics** tabs on the left. **Back to review** returns to your current review. Setup details stay in memory when you switch sections; save a connection to keep it.

For browser-only ticket links, choose **Jira → Browser links only** and enter your **Jira base URL**, such as `https://your-team.atlassian.net` or `https://jira.example.com/jira`. Choose **Save link settings**. The setting applies to projects without a connected Jira account. Use the site address before `/browse`, as described in [Atlassian’s site URL guide](https://support.atlassian.com/jira/kb/find-your-site-url-to-set-up-the-jira-data-center-and-server-mobile-app/).

When a branch contains a ticket key, such as `feature/APP-123-add-search`, an **APP-123 ↗** button appears beside it. Click to open the ticket in your default browser. Lowercase keys are normalized to uppercase; if a branch contains multiple keys, the first matching key is used. Current uses the latest checked-out branch, while saved reviews use their feature branch. Branches without a ticket key have no ticket button. If Jira has not been configured, the button opens Settings. Clear the base URL to remove the configuration.

## Connected Jira and Bitbucket reviews

Branchline can review existing **Bitbucket Cloud** PRs directly from the API, including related PRs across a project and its submodules. Opening a remote review does not fetch, check out, or change local branches. PR creation, fork-source PRs and full inbound Bitbucket discussions are deferred.

1. In **Settings → Jira** or **Settings → Bitbucket**, follow the account setup steps. Jira starts with your Cloud site URL, such as `https://team.atlassian.net`. Enter the account email, then use **Create Jira API token** or **Create Bitbucket API token** to open [Atlassian’s token settings](https://id.atlassian.com/manage-profile/security/api-tokens). Choose **Create API token with scopes**, select the matching product, and enable the permissions listed in Branchline. Paste the token and choose **Verify and save account**. Replacing a token preserves the verified account and Jira site; add another account to change identities or environments.
2. Open **Project integrations** and select the accounts. **Discover** maps the checkout and initialized submodules from their Git remotes. Correct or add workspace/repository mappings as needed.
3. Open **Pull requests** and choose All open, Needs my review, or Created by me. Matching source and target branches form a suggested group; select its repositories and open the review. Discovery refreshes every minute while visible, on focus, and manually, with rate-limit backoff.
4. Review the combined remote diff. Opening or reopening a PR review loads and caches its immutable source, destination and merge-base revisions, with the existing 1 MiB text limit. **Mark reviewed** records the cached file version locally and advances without contacting Bitbucket. The open diff stays stable until you reopen it, refresh manually or prepare feedback for publication. A refresh clears reviewed markers for files that changed. Unavailable/LFS content and incomplete comparisons are marked explicitly. Submodule pointer changes appear separately from files.
5. Expand **Jira ticket details** to read the title and formatted description. Branch keys are detected automatically; override the ticket key per review when needed. Open in Jira remains available.

For Bitbucket API tokens, select `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`. Optional pointer maintenance also needs `write:repository:bitbucket`. Scopes do not grant permissions the account itself lacks. See [Atlassian’s API token permissions](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/).

For Jira, use a scoped personal token with permission to read the current user and issues (`read:jira-user` and `read:jira-work`, or the equivalent granular scopes documented for [current user](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/) and [get issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)). Branchline discovers the site’s Cloud ID and uses the `api.atlassian.com` gateway. This initial integration uses personal tokens for internal use; a hosted OAuth exchange service is deferred.

### Publish inline feedback

Comments autosave locally until **Publish feedback**, which refreshes the PR snapshot before showing the preview. Publication checks the live PR revisions again immediately before sending. The preview lists each destination PR, file and exact old/new-side line range. Its **Open PR** buttons stay available after publication so you can inspect the comments and request changes in Bitbucket for each repository. File-level comments remain file comments. Edits, resolve/reopen and deletions are queued for the next publication and reuse the remote comment ID.

If a PR revision changes before a draft is published, select **Choose current lines…** and choose its new location. Approximate local comment placement never changes an outgoing remote anchor. Published comments retain their original anchors. External edits to Branchline-published comments are reconciled; conflicting local/remote edits require an explicit choice. Only the connected author’s comments can be changed.

Partial results persist across restarts. An uncertain request is marked **Delivery unknown** and is not blindly reposted. Refresh to reconcile it, or inspect Bitbucket and explicitly link an existing comment or acknowledge that it was not posted before allowing a retry. Native comment creation has no documented atomic revision condition or idempotency key, so a concurrent push during an individual request remains a provider limitation.

### Approve, merge and clean up

**Approve** records approval as the connected user. **Approve and merge** previews the PR group, uses standard `merge_commit` merges, and requests deletion of remote source branches. These actions are separate from marking files reviewed locally. Bitbucket’s permissions, allowed strategies and enforced merge checks remain authoritative.

The merge dialog shows one row per participating repository, with live checking, approval, merge and branch-cleanup progress. Merged repositories receive a check; PRs already merged are marked skipped. Source branches show **Deleted**, **Retained** or **Deletion unconfirmed** after cleanup is checked. When the entire group is confirmed merged, Branchline closes the active review back to **Current** and keeps a results panel visible. The saved review and its feedback remain available in the review selector. Failed or paused operations stay open for recovery; approving without merging keeps the review open.

When Bitbucket accepts an asynchronous merge, Branchline checks its task and PR status for up to 30 seconds before continuing to parent repositories. If confirmation takes longer or the remote state changes, the operation pauses with its completed results preserved. Resuming checks the accepted task again without resending that merge request.

Use **Open in Jira** in the merge dialog or results panel to update the ticket’s status in Jira. The link uses the project’s selected Jira site and the review’s explicit ticket key, falling back to its branch key. It remains available when the Jira API token has expired or been disconnected, and does not change ticket status automatically.

Children are processed before parents. A failure pauses the operation and leaves completed merges visible. Resume reconciles remote state and asynchronous tasks before continuing. A retained/protected source branch is reported separately from a successful merge. Local branches are not deleted. Multi-repository merges are not atomic, and revision checks cannot eliminate a concurrent push racing the merge endpoint.

**Update submodule pointers when merging** is off by default. Enabling it requires an existing editable parent PR for every affected ancestor, repository write access, and a configured Git author name/email. After child merges, Branchline creates a pointer-only parent commit using their actual merge results in an isolated app-owned bare Git workspace. It pushes only against the expected parent source revision. The parent pauses for review and checks before merging can resume. This optional action fetches and pushes Git objects without touching the user’s checkout, index or local refs. It never creates missing PRs.

### Integration storage and verification

Provider requests run in Electron’s main process. OS-encrypted credentials are stored in `credentials.json`, separately from `reviews.json` and `integrations.json`. If secure encryption is unavailable (including Linux’s `basic_text` fallback), tokens remain in memory and must be re-entered after restart. Disconnect removes local credentials without revoking the provider token. The disconnected account keeps its identity and review links; choose **Reconnect** to restore access to its saved feedback. API credentials are never put in Git remote URLs or application logs.

If a connection or PR fails, **Settings → Diagnostics → Open integration log** reveals the local diagnostic file. Requests record their method, redacted endpoint, status, timing and diagnostic identifier; invalid PR responses identify the affected fields and their types or lengths. Logs exclude tokens, authorization headers, query strings and response bodies, including review comments and issue descriptions. Logging is automatic and rotates to keep disk usage bounded. On macOS the file is normally `~/Library/Logs/Branchline/integrations.log`; Settings shows the exact location for the current installation. These logs stay on your computer and are not uploaded automatically.

Bitbucket can return abbreviated commit IDs in both PR lists and individual PR responses. Branchline resolves each abbreviation using the commit API and verifies the full hash before capturing a remote review. Invalid or mismatched commit responses produce an explicit error; branch names are never substituted for captured revisions.

Run `npm run test:desktop:integrations` after building for the connected-review UI smoke test. It uses the real Electron renderer with an isolated fixture bridge and no live credentials or provider writes. `npm run test:desktop:integration-backend` exercises the production main process and sandboxed preload with a temporary mocked network transport, verifies inline publication and merge requests, and rejects Git fetches or mutations during ordinary remote reviews. Mocked service tests cover API payloads and recovery; local Git tests cover pointer commits and exact push leases. Before release, verify renamed-file inline placement and merge/cleanup behavior using dedicated Bitbucket test PRs and a connected test account.

## Comparison semantics

Each repository is compared from `merge-base(target, feature)` to the feature revision (or its current working contents when eligible). This is the meaning of `git diff target...feature` for committed changes. Target-only commits do not appear as feature changes.

Local reviews use matching submodule branch names, independently of the parent repository's recorded submodule commit. Local branches are preferred; available remote-tracking branches are supported. The local review engine only reads Git data. Fetch or initialize submodules yourself when needed. Missing branches, uninitialized submodules, unresolved working-tree conflicts, and ambiguous merge bases produce visible notices. Connected PR reviews instead use immutable remote revisions; optional pointer maintenance is described above.

## Live changes and comments

An approval belongs to the exact before/after file version. Observing a new version clears it, even if the file later returns to its previous contents. Changes that happen and revert entirely between refreshes cannot be detected.

Existing comments retain their original side, line range, code context, and content fingerprint. Adding or editing feedback keeps unchanged code collapsed and preserves any context you expanded yourself. When a file changes, earlier feedback stays inline near the code it referred to, following line edits and saved surrounding context. If that location is collapsed, the feedback appears above the diff under **Comments on collapsed lines**, with its line reference and a code preview; expanding the relevant context returns it inline. If the exact code was removed or rewritten, it stays near the previous location. Open the compact earlier-version details to see its original context. File comments and comments without a text preview appear above the file notice.

Pending comments are saved before switching files or reviews, copying feedback, or closing the app. These local saves do not start another repository scan. Edits also have a local recovery copy scoped to their project, review, branch comparison, and file. If saving fails, the editor shows the error and retains the text for retrying.

## Local storage and boundaries

The Electron main process runs read-only Git commands for local reviews and persists projects and reviews in `reviews.json` under Electron's user-data directory (on macOS, normally `~/Library/Application Support/Branchline/`). Connected-review operations and optional pointer writes are described above. The renderer has an isolated, sandboxed preload bridge. Code is rendered locally with `@pierre/diffs` and file navigation uses `@pierre/trees`.

Binary files and files above 1 MiB show a metadata view and can be marked reviewed; inline text comments require a rendered text diff. Symlinks are reviewed as link targets without opening their destinations. Removed submodule pointers are reported as notices. Git must already be available locally. Local reviewing needs no account or hosted service. Installed macOS builds contact GitHub for updates; configured integrations contact Jira/Bitbucket directly and publish feedback only through explicit actions.

## Verify

```sh
npm test
npm run build
npm run test:desktop
npm run test:desktop:jira
npm run test:desktop:updates
npm run test:desktop:integrations
npm run test:desktop:integration-backend
```

The unit/integration tests create temporary Git repositories to exercise divergent targets, working contents, recursive submodules, missing refs, renames, binary/large files, symlinks, approval invalidation, persistence, and export. The desktop smoke test launches the real Electron app with a temporary repository and isolated user data, exercises the UI and clipboard, edits a file externally, checks automatic invalidation, and reopens the app to verify persistence. Screenshots are saved under `artifacts/`.

The Jira desktop check covers settings, branch detection, and persistence using isolated test data. It intercepts browser opening to verify the destination without visiting Jira.
