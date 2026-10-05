# Branchline

A desktop code review app for repositories with Git submodules. Review local branches or Bitbucket Cloud branches across repositories, read Jira context alongside the diff, and keep feedback local or publish it inline.

## Run

Requires Node.js 22.13+ and Git installed on your machine.

```sh
npm install
npm run dev
```

For a production build:

```sh
npm run build
npm start
```

`npm run package` produces an unpacked app for your machine and replaces the previous local app after a successful build. On Apple Silicon, open `release/mac-arm64/Branchline.app`. `npm run dist` produces installers; macOS builds include a universal DMG and ZIP for Intel and Apple Silicon. Local macOS packages are unsigned. The release workflow requires Developer ID signing and notarization.

## Styling

React component styles use StyleX. Define new component rules with `stylex.create` beside the component and apply them with `stylex.props`. Shared visual roles and sizing constants live in `src/theme/tokens.stylex.ts`; `src/theme/appThemes.ts` supplies the dark palette. The selected theme is applied to the document before React starts. Renderer styles live with their components in `src/features` and `src/ui`. Semantic DOM classes remain where desktop tests and integrations use them. `src/styles.css` contains only global reset and browser or Electron rules. `npm run lint` checks StyleX rules and architecture boundaries; `npm run format:check` checks source formatting. Both run during `npm run build`.

## Architecture

See [the architecture guide](docs/architecture.md) for folder ownership, component/hook boundaries, IPC contracts, and verification commands.

Navigation uses TanStack Router with routes in `src/routes` and a generated `src/routeTree.gen.ts`. Run `npm run routes:generate` after adding routes; development and build commands also generate the tree. Keep styles and implementation in their feature folders, with route files declaring destinations and layouts.

`App.tsx` mounts the router. `AppShell` owns application chrome and navigation guards; `WorkspaceProvider` loads shared projects, reviews and settings; `WorkspaceLayout` keeps the review editor mounted while Settings is visible. Current and saved-review destinations select the review through route parameters. Settings sections use `/settings/$section`, with the return workspace stored in history state. Transient dialogs and file selection remain feature state.

Review data, actions, display derivation and retirement live in separate review hooks. Electron close/update handling lives in `useAppLifecycle`. The memory history adapter guards Back/Forward as well as new destinations, so navigation waits for pending comment saves and stays in place on failure. Memory navigation preserves Electron's trusted document URL. Use Alt+Left/Right or, on macOS, Command+[/] for history. Startup restores the last project and opens its Current review.

Run `npm run test:desktop:routing` to exercise history, Settings state preservation and save failures against the built desktop app.

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

A **Bitbucket Cloud** PR starts a review of its source branch across every mapped repository and recursive submodule, against the same target branch. The combined diff includes changes in repositories without an open PR. Opening a remote review reads the APIs without fetching, checking out, or changing local branches. Fork-source PRs and full inbound Bitbucket discussions remain outside scope.

1. In **Settings → Jira** or **Settings → Bitbucket**, follow the account setup steps. Jira starts with your Cloud site URL, such as `https://team.atlassian.net`. Enter the account email, then use **Create Jira API token** or **Create Bitbucket API token** to open [Atlassian’s token settings](https://id.atlassian.com/manage-profile/security/api-tokens). Choose **Create API token with scopes**, select the matching product, and enable the permissions listed in Branchline. Paste the token and choose **Verify and save account**. Replacing a token preserves the verified account and Jira site; add another account to change identities or environments.
2. Open **Project integrations** and select the accounts. **Discover** maps the checkout and initialized submodules from their Git remotes. Correct or add workspace/repository mappings as needed.
3. Open **Pull requests** and choose All open, Needs my review, or Created by me. Choose **Review branch** on a group. The initial PR identifies the source and target branches; Branchline includes every mapped repository automatically. The repository list shows existing PRs, changes without a PR, no changes, missing source branches and unavailable repositories. Missing target branches, access failures and divergent PR targets are explicit blockers. Discovery refreshes every minute while visible, on focus, and manually, with rate-limit backoff.
4. Review the combined remote diff. Opening or reopening a PR review loads and caches its immutable source, destination and merge-base revisions, with the existing 1 MiB text limit. Repositories load concurrently with a bounded request limit. Each completed repository’s files appear immediately, so you can review and save feedback while the others load. The repository list shows checking and file-loading progress; after finishing the available files, the central review area shows the remaining repositories instead of an all-caught-up message. Publishing and merging stay disabled until every repository has finished loading. **Mark reviewed** records the cached file version locally and advances without contacting Bitbucket. The open diff stays stable until you reopen it, refresh manually or prepare feedback for publication. A refresh clears reviewed markers for files that changed. Unavailable/LFS content and incomplete comparisons are marked explicitly. Submodule pointer changes appear separately from files.
5. Click the **Jira ticket** button to open the full Jira page directly in a large in-app modal, where you can edit, comment and change ticket status using Jira’s own controls. In **Settings → Jira → Opening tickets**, choose **Ticket summary** if you prefer the lightweight, read-only title and formatted description. Branch keys are detected automatically. With no ticket selected, a small centred picker shows recent tickets from your connected Jira account and lets you search by key or title. Select a result to open it, or enter a key with **Use ticket**. Suggestions float over the picker without resizing it and use Jira’s issue picker history (viewed, edited or created tickets) with the existing `read:jira-work` permission. Search failures leave direct key entry available. While viewing a ticket, its key appears in a bordered badge in the top toolbar; the **×** clears that selection and returns to the picker, after checking for unsaved Jira edits. In **Current**, manual selections and cleared tickets apply to the checked-out branch. Changing branches discards that override and detects the new branch’s ticket, or leaves it unlinked if the branch has no ticket key. An open Jira modal closes when the checkout changes; if Jira reports unsaved edits, you can stay to finish them before closing. Saved and Bitbucket reviews keep their own ticket selection. **Ticket details** opens the read-only summary. **Open in browser** opens Jira in your normal browser.

The embedded Jira browser is a preview. Sign in with your Jira email and password separately from the API token; website sign-in is kept per saved Jira connection, persists across restarts, and is cleared by **Reset sign-in**, token replacement or disconnect. The toolbar shows the current website origin; use Jira’s own profile menu to confirm the signed-in user. Jira pages cannot access Branchline’s preload or local review APIs. Some identity providers refuse embedded sign-in; use **Open in browser** if that happens. Attachments and browser permission requests are disabled in this preview. Real account sign-in and editing still need a manual compatibility check before release.

The Jira modal uses a 48px toolbar, with connection details and **Reset sign-in** in the **⋯** menu. Loading stays inline; errors add a row only while present. Use Jira’s own **Collapse sidebar** control to give the ticket more width. Jira lists `Z` for issue full screen, but it did not hide navigation in the tested standalone `/browse/KEY` view. Branchline does not override Jira’s styles or claim a ticket-only full-screen mode.

For Bitbucket API tokens, select `read:user:bitbucket`, `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`. Repository write access is required to clean up empty branches and for optional pointer maintenance. If an existing token lacks repository write access, replace it in **Settings → Bitbucket** using the scopes shown there. Scopes do not grant permissions the account itself lacks. See [Atlassian’s API token permissions](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/).

For Jira, use a scoped personal token with permission to read the current user and issues (`read:jira-user` and `read:jira-work`, or the equivalent granular scopes documented for [current user](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/) and [get issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)). Branchline discovers the site’s Cloud ID and uses the `api.atlassian.com` gateway. This initial integration uses personal tokens for internal use; a hosted OAuth exchange service is deferred.

### Publish inline feedback

Comments autosave locally until **Publish feedback**, which refreshes the whole branch across all repositories before showing the preview. If a comment belongs to a repository without a PR, the preview shows **Create PR on publish**. Publishing creates that PR and then places the comment at its exact file and lines; writing a draft does not create a PR. Publication checks the live revisions again immediately before sending. The preview lists each destination repository or PR, file and exact old/new-side line range. Its **Open PR** buttons stay available after publication so you can inspect the comments and request changes in Bitbucket for each repository. File-level comments remain file comments. Edits, resolve/reopen and deletions are queued for the next publication and reuse the remote comment ID.

If a PR revision changes before a draft is published, select **Choose current lines…** and choose its new location. Approximate local comment placement never changes an outgoing remote anchor. Published comments retain their original anchors. External edits to Branchline-published comments are reconciled; conflicting local/remote edits require an explicit choice. Only the connected author’s comments can be changed.

Partial results persist across restarts. An uncertain request is marked **Delivery unknown** and is not blindly reposted. Refresh to reconcile it, or inspect Bitbucket and explicitly link an existing comment or acknowledge that it was not posted before allowing a retry. Native comment creation has no documented atomic revision condition or idempotency key, so a concurrent push during an individual request remains a provider limitation.

### Approve, merge and clean up

**Approve** records approval as the connected user. **Approve and merge** covers the reviewed source branch across the whole project, creates missing PRs for repositories with changes, uses standard `merge_commit` merges, and cleans up remote source branches, including matching empty branches in repositories that never needed a PR. These actions are separate from marking files reviewed locally. Bitbucket’s permissions, allowed strategies and enforced merge checks remain authoritative.

The merge dialog shows each repository's workflow stage: **Checking**, **Approving**, **Merging**, waiting for the other merges, **Deleting branch**, then **Done**. Repeated safety checks stay within that repository's stage. Repositories without changes wait for the cleanup stage; already merged PRs retain their results. The counter always counts completed repository workflows. Source branches show **Deleted**, **Retained** or **Deletion unconfirmed** after cleanup is checked. Once every merge and cleanup is confirmed, Branchline removes the saved review, returns to **Current**, and shows a completion dialog. Failed or paused operations remain available for recovery; approving without merging keeps the review open.

For older saved reviews, open the **Workspace menu (…) → Clean up closed Bitbucket reviews**. Branchline checks each review's original PRs with its saved Bitbucket connection and previews reviews whose PRs are all merged, declined or superseded. It rechecks before removal and keeps reviews with open or unverifiable PRs, unpublished repository changes without a PR, or unfinished merge/branch cleanup. The preview warns about unpublished feedback: removal deletes the local review and its feedback, while Bitbucket comments, PRs and branches stay unchanged. Removing the selected review returns you to **Current**.

Opening or refreshing a Bitbucket review also checks for completion outside Branchline. Once every PR is closed and every participating repository is verified finished, Branchline removes the review automatically and returns to **Current**. Deleted source and target branches are accepted for closed PRs and captured empty comparisons. Previously unique branch-only commits require a matching closed PR or proof that the remote target contains them; missing branches alone are insufficient. Recreated branches, permission failures, ambiguous PR history, pointer-review pauses and unpublished feedback keep the review available with a reason. Pending feedback is saved before a final recheck, and automatic cleanup never merges PRs or deletes remote branches. Closed PR files that remain in a partial review are labeled as historical changes.

Merge previews check the captured source and target commits using Bitbucket's [file-conflicts API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/#api-repositories-workspace-repo-slug-file-conflicts-spec-get), including repositories that still need a PR. Conflicts show the affected repository and files and disable merging. An unavailable or incomplete conflict check also blocks merging. Resolve the conflicts in Bitbucket or your development checkout, then refresh and review the changed code. Conflicts are checked again before each merge.

When Bitbucket accepts an asynchronous merge, Branchline checks its task and PR status for up to 30 seconds before continuing to parent repositories. If confirmation takes longer or the remote state changes, the operation pauses with its completed results preserved. Resuming checks the accepted task again without resending that merge request.

Use **Open in Jira** in the merge or completion dialog to update the ticket’s status in Jira. The link uses the project’s selected Jira site and the review’s explicit ticket key, falling back to its branch key. It remains available when the Jira API token has expired or been disconnected, and does not change ticket status automatically.

Before publishing or merging, Branchline checks every repository, including those previously showing no changes. New work pauses the operation for review. Missing PR creation is recorded before the request; uncertain creation is reconciled before any retry. Newly created PRs still need to satisfy required checks.

Independent repositories merge concurrently with up to four workers. Bitbucket is explicitly asked to retain source branches during merging. Only after **every required PR is confirmed merged** does Branchline start a separate cleanup stage, also with up to four workers, covering PR branches and unchanged branches. A failed or uncertain merge, or a pointer-review pause, prevents cleanup from starting. When pointer updates are enabled, children merge before their parent begins; siblings can still merge together. A failure stops scheduling new work; in-flight requests finish and their results are preserved before the operation pauses. Resume reconciles remote state and asynchronous tasks before continuing. Previously merged PRs remain reviewable even when their source branches were already deleted; missing sources on open PRs block the operation with recovery instructions. Successful deletion receipts are never used to delete a recreated branch.

A retained/protected source branch is reported separately from a successful merge. Empty branches are deleted only when their captured source commit is already contained in the target. Cleanup uses an isolated bare Git workspace and an exact expected-commit lease, so concurrent pushes and unmerged work are retained. This cleanup does not fetch, check out files, or alter local refs. Local branches are not deleted. Multi-repository merges and cleanup are not atomic: merge failures retain confirmed merges, and cleanup failures can still leave a mixture of deleted and retained branches. Those results remain resumable. Revision checks cannot eliminate a concurrent push racing the merge endpoint.

**Update submodule pointers when merging** is off by default. Enabling it requires an editable parent PR for every affected ancestor, repository write access, and a configured Git author name/email. Missing parent PRs must be established before pointer maintenance starts. After child merges, Branchline creates a pointer-only parent commit using their actual merge results in an isolated app-owned bare Git workspace. It pushes only against the expected parent source revision. The parent pauses for review and checks before merging can resume. This optional action fetches and pushes Git objects without touching the user’s checkout, index or local refs.

### Integration storage and verification

Provider requests run in Electron’s main process. OS-encrypted credentials are stored in `credentials.json`, separately from `reviews.json` and `integrations.json`. If secure encryption is unavailable (including Linux’s `basic_text` fallback), tokens remain in memory and must be re-entered after restart. Disconnect removes local credentials without revoking the provider token. The disconnected account keeps its identity and review links; choose **Reconnect** to restore access to its saved feedback. API credentials are never put in Git remote URLs or application logs.

If a connection or PR fails, **Settings → Diagnostics → Open integration log** reveals the local diagnostic file. Requests record their method, redacted endpoint, status, timing and diagnostic identifier; invalid PR responses identify the affected fields and their types or lengths. Logs exclude tokens, authorization headers, query strings and response bodies, including review comments and issue descriptions. Logging is automatic and rotates to keep disk usage bounded. On macOS the file is normally `~/Library/Logs/Branchline/integrations.log`; Settings shows the exact location for the current installation. These logs stay on your computer and are not uploaded automatically.

Bitbucket can return abbreviated commit IDs in both PR lists and individual PR responses. Branchline resolves each abbreviation using the commit API and verifies the full hash before capturing a remote review. Invalid or mismatched commit responses produce an explicit error; branch names are never substituted for captured revisions.

Run `npm run test:desktop:integrations` after building for the connected-review UI smoke test. It uses the real Electron renderer with an isolated fixture bridge and no live credentials or provider writes. `npm run test:desktop:integration-backend` exercises the production main process and sandboxed preload with a temporary mocked network transport, verifies inline publication and merge requests, and rejects Git fetches or mutations during ordinary remote reviews. Mocked service tests cover API payloads and recovery; local Git tests cover pointer commits and exact push leases. Before release, verify renamed-file inline placement and merge/cleanup behavior using dedicated Bitbucket test PRs and a connected test account.

## Comparison semantics

Each repository is compared from `merge-base(target, feature)` to the feature revision (or its current working contents when eligible). This is the meaning of `git diff target...feature` for committed changes. Target-only commits do not appear as feature changes.

Local reviews use matching submodule branch names, independently of the parent repository's recorded submodule commit. Local branches are preferred; available remote-tracking branches are supported. The local review engine only reads Git data. Fetch through the Git workspace, and initialize submodules manually when needed. Missing branches, uninitialized submodules, unresolved working-tree conflicts, and ambiguous merge bases produce visible notices. Connected PR reviews instead use immutable remote revisions; optional pointer maintenance is described above.

## Git workflow

Open the project's **Git** area beside **Reviews**. The left sidebar combines branches across the root and recursively discovered submodules into one searchable tree, with **Local** and **Remote** sections, remote folders such as **origin**, and collapsible folders for slash-separated branch names. Local and remote refs remain distinct even when they share a branch name. Checked-out local branches have a gold tag icon. Use the star beside a branch, or **Add to favourites** in its context menu, to pin it above the folders in its section. Favourites and collapsed folders survive restarting the app. Branches present in every repository appear once; partial branches show their repository names in brackets. Each branch shows ↓ incoming and ↑ outgoing commit counts summed across its repositories, with unavailable destinations shown as — or ?. Select a branch to inspect its repository coverage and destinations on the right, **Review** without changing the checkout, or **Check out** across the project. Remote-only branches become local tracking branches; missing or ambiguous branches and branches held by another worktree block checkout. Branch review requires the branch in the root repository. Right-click a branch (or press Shift+F10) for **New branch**, **Review**, **Check out**, **Fetch**, **Pull**, **Push**, and **Rename**. Pull and Push in the menu require the clicked branch checked out in every repository. A commit graph is deferred.

**New branch** creates a local branch from the selected local or remote ref in every repository, leaving checked-out files, index, and branches untouched. **Rename** renames an existing local branch across the project. It retains upstream tracking and remote branch names; saved reviews keep their recorded branch names. Both actions require a preview and block the entire project on invalid names, missing sources, existing destinations, or branch folder collisions. Rename also blocks branches held by another worktree. Local edits may remain for these actions.

**Fetch** updates branch information without changing checked-out files. Saved branches and counts appear immediately from `git-status-cache.json` on restart, marked as cached while refreshing. Repository reads and fetches run concurrently and update the list as each repository finishes; a slow repository does not hold back results from the others. The display cache never replaces the live Git checks required for an action preview. Branchline also fetches when opening a project in a local review, every five minutes while active, and on focus when stale. Viewing a cached Bitbucket review keeps its existing read behaviour; opening its Git workspace enables the local workflow controls. Failed fetches retain cached counts and show a stale-information warning. Git uses your existing local credentials and SSH configuration; configure authentication outside Branchline if it fails.

**Pull project** and **Push project** require matching branch names across every repository. Each action shows its destinations and blockers before confirmation. Pull fetches first and only fast-forwards: even a conflict-free divergent history must be merged or rebased manually. Checkout and Pull require clean files and index, including untracked files. Unstaged pointer differences are warnings when child repositories are clean; staged pointer changes block. Push sends committed changes, so local edits can remain. Unpublished branches require a selected remote and establish tracking only after a successful push. Different configured push remotes and push URLs are shown in the preview; custom push refspecs, mirror remotes, and multiple push URLs require manual handling.

The root and recursively discovered submodules are checked before any checkout, fast-forward, push, branch creation, or rename begins. Missing or uninitialized repositories and submodule path changes block the operation. Checkout and Pull update parents before children without detaching submodule branches. Push publishes children before their parents and checks referenced child commits. Pointer commits, staging, committing, stashing, conflict resolution, force pushes, and branch deletion remain manual.

Actions are checked again immediately before each repository step. If a later step fails, completed steps remain and the result for each repository is saved in `git-workflow.json`. An interrupted or uncertain result is checked against Git before another action; if it cannot be verified, inspect it manually and use **I checked the uncertain results manually** before preparing a new preview. Branchline never automatically rolls back or replays Git writes. Pending feedback is saved before an action, and Jira's unsaved-edit guard is respected before checkout or rename. Run `npm run test:desktop:git` after building for the hidden Electron workflow smoke test against temporary local repositories and bare remotes.

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
npm run test:desktop:jira-browser
npm run test:desktop:updates
npm run test:desktop:integrations
npm run test:desktop:integration-backend
```

Local desktop smoke tests keep Electron windows hidden by default. Set `BRANCHLINE_SMOKE_VISIBLE=1` to watch a local run; CI keeps the windows visible.

The unit/integration tests create temporary Git repositories to exercise divergent targets, working contents, recursive submodules, missing refs, renames, binary/large files, symlinks, approval invalidation, persistence, and export. The desktop smoke test launches the real Electron app with a temporary repository and isolated user data, exercises the UI and clipboard, edits a file externally, checks automatic invalidation, and reopens the app to verify persistence. Screenshots are saved under `artifacts/`.

The Jira desktop check covers settings, branch detection, and persistence using isolated test data. It intercepts browser opening to verify the destination without visiting Jira.
The Jira browser desktop check uses the production main process and preload with simulated HTTPS pages. It covers direct modal opening independently of the issue API, view preference persistence, native view layout, account isolation, persistent cookies, popup isolation, disconnect cleanup and trusted IPC; it does not validate Atlassian login or real issue writes.
