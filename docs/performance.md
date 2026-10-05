# Performance changes

The diff workspace follows [Diffshub's stacked, collapsible file layout](https://github.com/pierrecomputer/pierre/blob/5cce4b7e6838f6da4823b461becf1e9d480eaee4/apps/diffshub/components/DiffsHubViewer.tsx) and [bounded syntax worker pool](https://github.com/pierrecomputer/pierre/blob/5cce4b7e6838f6da4823b461becf1e9d480eaee4/apps/diffshub/components/WorkerPoolContext.tsx), using the installed `@pierre/diffs` APIs.

- File bodies load near the viewport, and Pierre's virtualizer renders visible code rows. The existing file filters, tree selection, comments and reviewed markers still apply. Each file has a sticky accordion header and a reviewed action.
- Diff parsing runs in a separate worker, with shared requests and a cache bounded by file size and entry count. A linear path handles large replacements only when the two versions have no matching lines; ordinary changes retain Pierre's exact hunk/context behavior. Syntax highlighting uses at most three workers.
- Git readers coexist. Writes wait for earlier readers/writes touching the same checkout, containing repository or shared Git directory. Independent projects proceed concurrently; linked worktrees and parent/submodule overlap remain protected.
- Repository preflights run with concurrency four. Pushes run in descendant-first waves, with up to four sibling repositories at once. Checkout and pull retain their ordered mutations. Started writes drain before recovery inspects their results.
- Snapshot refreshes read sibling repositories concurrently with a traversal limit of four, and blob batches use concurrency three. Git status checks reuse one Git-directory lookup for merge/rebase markers instead of launching seven commands.
- Intermediate Git display-cache writes run in the background and coalesce; final snapshots still await persistence. Publication captures new draft anchors in one durable update.
- Comment deliveries run with concurrency three. Each comment's create/update/resolve steps remain ordered and journaled before sending. Publication freezes intent before allowing local edits and reviewed markers to save during delivery; later edits belong to the next batch. Shutdown and settings changes continue to track all accepted work. A failure stops scheduling further comments and drains deliveries already started. Remote revision checks remain immediately before each write and after delivery.

## Local measurements

Compared with checkout `5edb27b`, using the same local fixture of four repositories, 160 changed files and 200 lines per file. Warm figures are the mean of three runs, following one cold run. These are fixture measurements, not estimates of real provider/network latency.

| Operation | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Warm Git status scan | 210 ms | 179 ms | 15% |
| Git commands per warm status scan | 104 | 81 | 22% |
| Warm snapshot refresh | 188 ms | 116 ms | 38% |
| Cold Git status scan | 294 ms | 220 ms | 25% |
| Cold snapshot refresh | 210 ms | 136 ms | 35% |

The production Electron stress fixture contains 46 file accordions and an 18,000-line replacement. Initially, one file body mounts and 200 code rows render. The test also checks collapse/expand, selecting a distant file, saving a draft against that file, and reopening it. The existing blocked-background-scan test saves pending feedback and advances Mark reviewed while the comparison remains blocked (104 ms in the measured run).

## Reproducing checks

```sh
npm test
npm run build
npm run test:desktop
npm run test:desktop:routing
npm run test:desktop:git
npm run test:desktop:background-review
npm run test:desktop:integrations
npm run test:desktop:integration-backend
npm run test:desktop:performance
npm run benchmark:performance
# Optional baseline checkout, with dependencies available:
node --import tsx scripts/benchmark-performance.mjs /absolute/path/to/baseline
```

Desktop checks use isolated data and hidden windows locally. No benchmark sends requests to a real Git remote or comment provider. Actual network latency, remote hooks and provider rate limits still affect completion time; measurements above establish local improvements and concurrency behavior.

Branch manager follow-up: routine local checks now publish one coherent result only when data changes. Unchanged checks skip renderer events and display-cache writes. Discovery shares HEAD, index, and module-tree reads with inspection, removing three duplicate Git subprocesses per repository per scan. The renderer retains unchanged branch/repository references, coalesces repeated fetch requests, and avoids redundant scans after fetch or action preview. Preview completion no longer refreshes every review. Initial loading and fetch still show progressive results; mutation preflight and durable receipts are retained.

The branch sidebar reserves a fixed footer for status so refresh messages cannot shift the tree. Branch actions are available through visible row menus and New branch/Rename buttons. The desktop Git suite checks stable row identity, geometry, scroll, selection and open menus across repeated reads, fetch coalescing on focus, cached startup, and real branch operations across nested repositories.
