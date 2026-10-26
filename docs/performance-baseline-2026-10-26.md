# Performance baseline from a screen recording, 26 October 2026

This file records how long Branchline made the user wait during one real session. The source is a 125.6 s screen recording of Branchline 0.15.0 on the Envisionsoft project. It was recorded at 14:01:33 UTC on 26 October 2026. Each wait is matched against the Bitbucket request log for the same minutes. Use these numbers as the "before" figures for any performance work.

## Summary

Branchline was busy for about 105 s of the 125.6 s recording. That is 84% of the session spent waiting. The two largest waits are the Approve and merge run (49.2 s) and rebuilding the Current review (30.0 s).

## Waits in the recording

Times are seconds from the start of the recording. Add 14:01:33 UTC to get the time in the log.

| # | What the user did | Start | End | Wait | What happened during the wait |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Current review shows "Gathering your changes" | before 0.0 | 4.1 | at least 4.1 s | Already loading when the recording started. The user gave up and opened Pull requests. |
| 2 | Opened Pull requests, "Finding pull requests…" | 4.1 | 6.75 | 2.65 s | 8 requests (5 `pullrequests`, 3 `commit`). The same list was fetched 39 s earlier. |
| 3 | Clicked Review branch on TARA-211, "Opening review…" | 8.65 | 10.75 | 2.1 s | 0.87 s before the first request, then 3 requests one after another. |
| 4 | TARA-211 review loads 5 repositories | 10.75 | 20.1 | 9.35 s | 105 requests, up to 9 at once. First files appeared at 14.7. Publish, Approve and Approve and merge look disabled until all 5 repositories finish. |
| 5 | Opened Approve and merge, "Checking repositories…" | 27.9 | 35.5 | 7.6 s | 42 requests, including 12 branch lookups. |
| 6 | Clicked "Approve, merge and delete branches" | 37.7 | 86.9 | 49.2 s | 350 requests, of which 11 are writes. Stages are below. |
| 7 | Clicked Done, Current review shows "Gathering your changes" again | 90.05 | 120.05 | 30.0 s | No Bitbucket requests. Local work only. See finding 1. |

Total app waiting time is 4.1 + 2.65 + 2.1 + 9.35 + 7.6 + 49.2 + 30.0 = 105.0 s.

### Stages of the merge run (wait 6)

| Stage shown in the dialog | Start | End | Duration |
| --- | ---: | ---: | ---: |
| Checking… | 37.7 | 52.0 | 14.3 s |
| Creating PR… (3 new pull requests) | 52.0 | 54.8 | 2.8 s |
| Checking… again | 54.8 | 62.6 | 7.8 s |
| Approving… | 62.6 | 63.7 | 1.1 s |
| Merging… | 63.7 | 76.4 | 12.7 s |
| Deleting branch… | 76.4 | 86.9 | 10.5 s |

From opening the dialog at 27.9 to the end at 86.9, Branchline made 393 Bitbucket requests. Only 11 were writes (3 create pull request, 4 approve, 4 merge). The rest were reads, including 94 branch lookups, 110 commit lookups and 29 commit status lookups. Wait 5 and the first stage of wait 6 make the same kinds of branch, commit and merge-base lookups 2 s apart, which suggests the same checks run twice (inferred from the request mix).

## Findings

### 1. "Gathering your changes" reads 178,964 untracked files, then drops the result (30.0 s)

The Current review compares `ethan/react-ui-library` with `v3.6` and includes local edits. The Envisionsoft root repository has an untracked, unignored `packages/ui/` folder. It holds `node_modules` (177,806 files), `storybook-static` (471) and `dist` (211).

Building the same snapshot outside the app with `scripts/profile-snapshot.mjs` gives these results.

- It takes 21.7 s to 25.0 s per run, median 23.4 s, over 6 runs. Each run builds the same 531 files.
- Git accounts for 1.8 s to 2.5 s of that, across 70 to 80 Git commands.
- The build opens 178,964 files. Almost all of them are in `packages/ui/`. `readWorkingFile` in `electron/git/repository.ts` reads and hashes each one.
- A CPU profile shows the process idle 45% of the time, waiting on file system calls, with most of the rest in hashing, buffer allocation and garbage collection.
- After reading every file, `files.push(...reviewed)` at `electron/git/repository.ts:543` throws "Maximum call stack size exceeded". The root repository is then dropped with a warning. None of the 531 files in the review come from the root repository.

This is a correctness bug as well as a slow path. Any real changes in the Envisionsoft root repository are left out of the Current review. The "1 repository notice" banner on the Current review is probably this warning (inferred from the matching warning in the standalone run). The TARA-211 review's notice is a different one, because its root repository has no `Connor/TARA-211` branch.

The in-app wait (30.0 s) is longer than the standalone build (21.7 s to 25.0 s). The cause of the extra time is not measured.

### 2. Results are not kept between visits

- The Current review was rebuilt from scratch twice in two minutes. The second rebuild took 30.0 s with nothing shown in the meantime. `reviews.json` stores no snapshot for any review. What triggered the rebuild after the merge was not traced.
- The pull request list was fetched at -39 s and again at 4.1 s with the same 5 `pullrequests` requests.
- The merge pre-check (wait 5) and the first "Checking…" stage of the merge run make the same kinds of lookups 2 s apart (inferred from the request mix).

### 3. The merge dialog's spinners never move

The spinner area in the merge dialog changed 0% between frames over 10 s. The "Gathering your changes" spinner changed about 14% per frame over the same kind of window. `reducedMotionSpinner` in `src/features/integrations/MergeProgressView.tsx:245` sets `animationName` to `null` by default, which overrides `spinStyle`. This cause is read from the code and is not yet confirmed by a fix. The effect is that a 49 s merge looks frozen.

### 4. Review actions wait for the slowest repository

Publish feedback, Approve and Approve and merge look disabled until every repository finishes loading. In wait 4, the first files were visible after 3.95 s, but the actions unlocked after 9.35 s.

## Not slow

Switching files and scrolling diffs at 23.8 s to 27.9 s showed no loading state. The recording does not show click markers, so these were not timed.

## Unknowns

- How long the first "Gathering your changes" (wait 1) lasted. The recording started part-way through.
- Why the in-app rebuild (30.0 s) was slower than the standalone build (21.7 s to 25.0 s). After the fixes the gap is 1.0 s to 1.6 s in the app against 0.73 s to 0.90 s outside it. The remaining overhead is not broken down.
- The cost of branch deletion itself. It does not appear in the Bitbucket log, so it probably runs through Git (inferred).

## Precision

- Times from the 20 frames per second region traces are accurate to about 0.05 s. These are waits 2, 3 and 7.
- Times from the 10 frames per second traces and 2 frames per second frames are accurate to about 0.5 s. These are waits 4, 5 and 6 and the merge stages.
- Log timestamps are exact to the millisecond. The recording's clock and the log's clock agree: the dialog's "Checked 2:01:40 PM" text appears 6.75 s into the recording, which is 14:01:39.75 UTC.
- The standalone snapshot figures are 6 runs on a machine with a load average of 2.8 to 6.3 on 10 cores. Branchline itself was not running.

## After the fixes

These figures come from the branch `claude/performance-fixes`. The Bitbucket waits cannot be replayed against the real service without merging real pull requests, so those rows use test harnesses with a fixed simulated latency. Real times depend on Bitbucket's latency.

| Wait | Before | After | How it was measured |
| --- | ---: | ---: | --- |
| Current review, first build in the app | 30.0 s | 1.0 s to 1.6 s | `scripts/time-current-review.mjs`, 3 runs, load average 7 to 12 |
| Current review, later refreshes in the app | about 30 s each, restarted 4 s after each one finished | 0.85 s to 0.93 s | Same script, 9 refreshes |
| Current review, coming back to it | 30.0 s | 0.23 s to 0.24 s to the first file | Same script, after a reload, 3 runs |
| Current review build outside the app | 21.7 s to 25.0 s | 0.73 s to 0.90 s | `scripts/profile-snapshot.mjs`, 5 runs |
| Pull request list, first open | 7 requests, 920 ms | 7 requests, 620 ms | `tests/bitbucket-requests.test.ts`, 300 ms per request, 5 runs per side |
| Pull request list, reopening | 7 requests, 920 ms | Shown at once from the last list, refreshed behind it | Same test, and checked in the app by the agent that built it |
| Opening a review | 5 requests, 1,510 ms | 3 requests, 610 ms | Same test |
| Loading a 5-repository Bitbucket review | 106 requests, 6,630 ms; first files at 3,330 ms | 86 requests, 2,140 ms; first files at 2,130 ms | Same test |
| Approve and merge, Bitbucket calls | 228 calls, 57 serial round trips | 198 calls, 28 serial round trips | `tests/merge-read-budget.test.ts`, one round trip per call |
| Approve and merge dialog check | 11 serial round trips | 6 serial round trips | Same test |

The merge harness counts client calls, not HTTP requests. In production some calls also resolve abbreviated commit hashes, so the real request count is higher than the call count.

### What changed

- **Untracked folders.** A whole untracked folder with more than 1,000 files is left out with a notice naming it, instead of being read and hashed file by file. The stack overflow that dropped the root repository is fixed, so the Current review now includes 30 root-repository files it was silently missing.
- **Kept results.** The main process keeps the last finished comparison for each local review, even after a Git operation invalidates it. When the screen has nothing to show for a review, it shows that result at once and refreshes behind it. Approvals and comments still validate against a fresh comparison.
- **Spinners.** The merge dialog and repository loading list now animate. `scripts/smoke-integrations.mjs` checks both. On the old code its loading spinner check fails. The merge spinner check uses the same mechanism but was not run against the old code, because the test stops at the first failure.
- **Pull request list.** The main process keeps the last list per project and the dialog shows it while refreshing. Commit hashes for a pull request resolve in parallel, and the pull requests in a list resolve four at a time.
- **Bitbucket reviews.** Each repository's checks start together instead of one after another. A repository's files start loading as soon as its own checks finish, without waiting for other repositories. Reads that repeated the discovery step's reads within one load are gone. A connection runs at most 20 requests at once.
- **Approve and merge.** The run reuses the group check it has just made instead of running it a third time before creating pull requests. Branch cleanup reads its four preconditions at once, and it no longer re-reads a branch that the deletion itself has just confirmed is gone. Every write is still preceded by the reads that guard it, and the merge test checks this.

### Not changed yet

- While the Current review is open, it still rebuilds every 4 seconds. Each rebuild now takes under a second instead of about 25 seconds. Rebuilding only when files change would need a file watcher.
- Kept results live in memory only, so the first view after the app starts still builds from Git.
- The Git tab's status check still lists every untracked file. Changing it would weaken the check that a repository has not changed between previewing and running a checkout or pull.
- Each Bitbucket file still costs four requests: a metadata and content pair for each side.

## How to rerun

Measure screen changes in a recording. `blackframe` reports the share of unchanged pixels between consecutive frames.

```sh
ffmpeg -i recording.mp4 -vf "fps=10,scale=750:-2,format=gray,tblend=all_mode=difference,blackframe=amount=0:threshold=12" -an -f null - 2>&1 | grep pblack
```

Extract frames to look at.

```sh
ffmpeg -i recording.mp4 -vf "fps=2,scale=1500:-2" -q:v 3 frames/%04d.jpg
```

Group Bitbucket requests by wait. Read `~/Library/Logs/Branchline/integrations.log`, keep `event: "http"` lines, take each request's start as `time - durationMs`, and count requests whose start falls inside each wait.

Build the Current review snapshot outside the app.

```sh
node --import tsx scripts/profile-snapshot.mjs /Users/ethanbarlow/Envisionsoft ethan/react-ui-library v3.6 --working-tree --runs=3
```

Time the Current review in the built app. Run `npm run build` first. The script uses a throwaway data folder and blocks Git network transports, so the app's automatic fetch cannot change the repository's remote branches.

```sh
node scripts/time-current-review.mjs /Users/ethanbarlow/Envisionsoft ethan/react-ui-library
```

Print the merge and Bitbucket request budgets.

```sh
MERGE_READ_BUDGET=1 node --import tsx --test tests/merge-read-budget.test.ts
node --import tsx --test tests/bitbucket-requests.test.ts
```
