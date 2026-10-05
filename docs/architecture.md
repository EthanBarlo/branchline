# Architecture

For a visual introduction, read the [architecture walkthrough](architecture-walkthrough.md), including component composition, StyleX ownership, comment saves, and navigation guards.

Branchline has three code boundaries. `src` runs in a browser renderer, `electron` owns native and provider access, and `shared` defines the data exchanged between them. The renderer calls the typed preload API; it does not import desktop services. `npm run lint` enforces these dependency directions during every build.

## Source layout

| Location | Responsibility |
| --- | --- |
| `src/routes`, `src/router.ts` | Typed destinations and persistent layouts. Route files compose features. |
| `src/features/workspace` | App chrome, boot state, navigation, appearance, and renderer close/update coordination. |
| `src/features/reviews/workspace` | Review screen composition and its dialogs. |
| `src/features/reviews/session` | Review snapshots, mutations, selection, and retirement. |
| `src/features/reviews/diff` | Diff rendering, comment editors, autosave sessions, and annotation placement. |
| `src/features/reviews/tree` | File-tree adapter, selection, expansion, approval menu, and ordering. |
| `src/features/integrations/connections` | Account setup, credentials forms, permissions, and connection actions. |
| `src/features/integrations/remote-review` | Remote feedback publication and pull-request actions. |
| `src/features/jira/browser` | Embedded Jira dialog and native-view session coordination. |
| `src/features/jira/tickets` | Ticket picker and cancellable suggestion searches. |
| `src/features/projects`, `src/features/settings` | Project dialogs and application settings. |
| `src/features/git` | Project Git status, fetch scheduling, action previews, and progress. |
| `src/ui`, `src/lib`, `src/theme` | Shared controls, platform-independent renderer helpers, and StyleX theme definitions. These cannot depend on features. |
| `src/jira-browser` | Standalone Jira toolbar renderer and HTML entrypoint. |
| `electron/application` | Desktop window lifecycle, close/update gates, and native Jira operation sequencing. |
| `electron/ipc` | Trusted request registration and handler groups. |
| `electron/projects`, `electron/reviews`, `electron/git` | Local project/review persistence, comparison services, and Git operations. |
| `electron/integrations` | Connections, provider coordination, persistence, and diagnostics. Jira and Bitbucket rules have their own subfolders. |
| `electron/updates` | Update checks, download/install state, and platform installation. |
| `shared` | Domain models, preload API, IPC names/types, and platform-independent rules. |

Keep production entrypoints small: `src/main.tsx`, `src/App.tsx`, `electron/main.ts`, and the two Electron preloads compose their owners. Both renderer HTML entrypoints are built by Vite; the desktop entrypoint filenames are preserved by the Electron bundle step.

## Components, hooks, and helpers

- Components own markup, accessibility, and their StyleX rules. Shared visual values come from `src/theme/tokens.stylex.ts`; theme overrides live in `src/theme/appThemes.ts`.
- Hooks own a cohesive state lifetime or subscription. Keep the associated refs, cleanup, and asynchronous request sequencing together.
- Pure helpers own derivation or policy that can be understood without mounting a component. Keep them beside the feature that uses them.
- Compose shared controls through their props. Do not copy button/input styling into each feature, or centralize unrelated component styles in a global registry.
- Import the owning module directly. Avoid forwarding modules left behind after a move and feature-wide barrels that hide dependencies.

A component does not need splitting just because it contains many lines of local styles. Split when unrelated workflows, state machines, or independently useful UI sections are mixed together.

## State and lifecycle ownership

The router owns project, review, and Settings-section identity. Memory history leaves Electron's trusted document URL unchanged. The persistent workspace layout keeps the diff editor mounted when Settings opens. Pending comment saves guard all history directions; failures keep the current workspace available for retry.

The review data owner keeps context/version bookkeeping private. Other hooks use named operations and live selection queries instead of mutating its refs. This preserves the distinction between a snapshot refresh and a feedback mutation: a late refresh must not overwrite a newer comment, approval, target, or selected review. Retirement is registered before refresh polling begins.

Comment editor sessions keep their existing identity across rerenders. Their owner restores backups, reconciles persisted comments, and handles draft cleanup. The tree adapter owns selection and expansion together, including deferred events from the third-party tree model.

Jira native-view lifetime stays separate from dialog markup. Ticket changes first ask the existing native view to close; a declined unsaved-edit prompt keeps it attached. Search requests have their own generation counter so old results cannot replace a newer query.

Desktop handlers share one sender-trust check and operation gate. `shared/api.ts` describes the renderer facade; `shared/ipc.ts` derives request arguments and results from that facade. Handler groups cannot silently diverge from preload method signatures. Native close/install preparation drains accepted writes and waits for the renderer's matching flush acknowledgement before proceeding.

The Git workflow service owns checkout, fast-forward pull, non-force push, local branch creation, and rename. Its process-wide guard allows concurrent reads, drains existing readers before writes, and blocks new readers until a write finishes. This protects overlapping projects and snapshot consistency while keeping lightweight comment checkout checks independent of long diff scans. Git previews capture repository identity, branch/head, dirty state, and explicit destinations; execution checks them again. Mutation boundaries invalidate local snapshot generations, so an older scan cannot publish an intermediate checkout. Ordinary comparison code stays read-only. Operation receipts and fetch timestamps live separately in `git-workflow.json`; interrupted writes are reconciled rather than replayed. Automatic fetching is active for local reviews and explicitly opened Git workspaces, preserving cached Bitbucket review behaviour.

The integration coordinator retains serialization and durable write ordering. Jira ticket selection and closed-review eligibility are separate domain services; extracting those rules must not move provider operations outside the coordinator's locks or change recovery receipts.

## Verification

`npm run build` generates routes, typechecks, enforces dependency and StyleX rules, checks source formatting, and builds both renderer surfaces plus Electron. `npm test` covers domain rules, save/refresh races, IPC/lifecycle contracts, and dependency rules.

Run desktop suites after building:

- `test:desktop`: review editing, autosave, tree selection, approvals, and persistence.
- `test:desktop:routing`: route history, editor lifetime, pending/failed saves, and deleted destinations.
- `test:desktop:background-review`: edits and approvals while repository scans are pending.
- `test:desktop:integrations` and `test:desktop:integration-backend`: connection forms, remote workflows, and real IPC/provider payload wiring against mocked providers.
- `test:desktop:jira` and `test:desktop:jira-browser`: ticket selection, native browser sizing, focus, and close/ticket-change races.
- `test:desktop:updates`: updater and close/install coordination with the native test driver.
- `test:desktop:git`: branch review and checkout, incoming counts, fast-forward pull, first publication, feedback preservation, and divergence blocking against temporary Git remotes.

Keep test scenarios tied to observable behavior. Existing desktop selectors and component keys are contracts during refactoring; change them deliberately alongside coverage.

The dedicated `/projects/$projectId/git` workspace shares project navigation and guarded history with Reviews. `GitBranchSidebar` renders one Local/Remote branch tree across all discovered repositories, using `sidebarBranches` for separate reference identities and `branchTree` for folders/search, pinned favourites, and aggregate counts. Favourites and collapsed folders are project-scoped renderer preferences. Checked-out branches use a tag icon. Workflow snapshots contain local/remote membership and destination counts for every logical branch, including submodule-only branches. A display-only `GitWorkflowCache` persists snapshots in `git-status-cache.json`, keyed by saved project identity and repository path. `getCachedGitStatus` restores the list without querying Git. Status scans discover membership separately from inspection, read and fetch repositories concurrently, and publish partial snapshots over the existing workflow event channel. Pending paths retain cached entries until the complete topology is known. Publication versions prevent late results replacing newer ones; streamed status events do not trigger comparison refreshes. Mutation preflights always discover the full live project under the existing barrier. Non-current and per-remote counts are cached against effective Git configuration and ref revisions; external changes invalidate that cache. Selecting a branch reads its details; checkout and publication remain explicit, previewed writes.
