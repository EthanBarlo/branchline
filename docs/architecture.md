# Architecture

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

Keep test scenarios tied to observable behavior. Existing desktop selectors and component keys are contracts during refactoring; change them deliberately alongside coverage.
