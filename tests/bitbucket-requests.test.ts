import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { IntegrationService } from '../electron/integrations/integration-service';
import { IntegrationStore } from '../electron/integrations/integration-store';
import { ReviewStore } from '../electron/reviews/review-store';
import { ReviewService } from '../electron/reviews/review-service';
import { BitbucketClient } from '../electron/integrations/bitbucket/bitbucket-client';
import type { ConnectionManager } from '../electron/integrations/connection-manager';
import type { PointerService } from '../electron/git/pointer-service';
import type { RepositoryMapping } from '../shared/integrations';
import type { Review } from '../shared/types';

// Every simulated Bitbucket request takes one round trip, so budgets read as round trips.
const LATENCY = 300;
const feature = 'feature/APP-370';
const short = (hash: string) => hash.slice(0, 12);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

interface SimulatedRepository {
  mapping: RepositoryMapping;
  source?: string;
  target: string;
  mergeBase: string;
  files: string[];
  pr?: number;
}

/** Like the recorded project: one PR with abbreviated hashes, three branch-only repositories, one without the branch. */
function repositories(): SimulatedRepository[] {
  const hashes = (index: number) => ({
    source: `${index}a`.repeat(20),
    target: `${index}b`.repeat(20),
    mergeBase: `${index}c`.repeat(20),
  });
  const mapping = (relativePath: string, repoSlug: string): RepositoryMapping => ({
    relativePath,
    workspace: 'team',
    repoSlug,
  });
  return [
    {
      mapping: mapping('.', 'app'),
      ...hashes(1),
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      pr: 370,
    },
    { mapping: mapping('packages/api', 'api'), ...hashes(2), files: ['api/a.ts', 'api/b.ts', 'api/c.ts'] },
    { mapping: mapping('packages/web', 'web'), ...hashes(3), files: ['web/a.ts', 'web/b.ts', 'web/c.ts'] },
    { mapping: mapping('packages/ui', 'ui'), ...hashes(4), files: ['ui/a.ts', 'ui/b.ts', 'ui/c.ts'] },
    { mapping: mapping('packages/docs', 'docs'), ...hashes(5), source: undefined, files: [] },
  ];
}

function simulator(repos: SimulatedRepository[]) {
  const requests: { path: string; start: number }[] = [];
  const pullRequest = (repo: SimulatedRepository) => ({
    id: repo.pr,
    title: 'APP-370 changes',
    state: 'OPEN',
    source: {
      branch: { name: feature },
      commit: { hash: short(repo.source!) },
      repository: { full_name: `team/${repo.mapping.repoSlug}` },
    },
    destination: {
      branch: { name: 'main' },
      commit: { hash: short(repo.target) },
      repository: { full_name: `team/${repo.mapping.repoSlug}` },
    },
    author: { uuid: '{author}', display_name: 'Author' },
    reviewers: [{ uuid: '{reviewer}', display_name: 'Reviewer' }],
    participants: [],
    links: { html: { href: `https://bitbucket.org/team/${repo.mapping.repoSlug}/pull-requests/${repo.pr}` } },
  });
  const respond = (url: URL): Response => {
    const [, , , , slug, kind, ...args] = url.pathname.split('/');
    const repo = repos.find((value) => value.mapping.repoSlug === slug);
    if (!repo) return json({}, 404);
    if (!kind) return json({ full_name: `team/${slug}`, mainbranch: { name: 'main' } });
    if (kind === 'pullrequests' && !args.length) {
      const query = url.searchParams.get('q');
      const listed =
        repo.pr &&
        url.searchParams.getAll('state').includes('OPEN') &&
        (!query || query === `source.branch.name=${JSON.stringify(feature)}`);
      return json({ values: listed ? [pullRequest(repo)] : [] });
    }
    if (kind === 'pullrequests' && args.length === 1 && Number(args[0]) === repo.pr)
      return json(pullRequest(repo));
    if (kind === 'commit' && args[1] === 'statuses') return json({ values: [] });
    if (kind === 'commit') {
      const hash = [repo.source, repo.target, repo.mergeBase].find((value) => value?.startsWith(args[0]));
      return hash ? json({ hash }) : json({}, 404);
    }
    if (kind === 'refs' && args[0] === 'branches') {
      const name = decodeURIComponent(args[1]);
      const hash = name === 'main' ? repo.target : name === feature ? repo.source : undefined;
      return hash ? json({ name, target: { hash }, merge_strategies: ['merge_commit'] }) : json({}, 404);
    }
    if (kind === 'merge-base') return json({ hash: repo.mergeBase });
    if (kind === 'diffstat')
      return json({
        values: repo.files.map((path) => ({
          status: 'modified',
          lines_added: 1,
          lines_removed: 1,
          old: { path },
          new: { path },
        })),
      });
    if (kind === 'src') {
      const path = args.slice(1).map(decodeURIComponent).join('/');
      const body = `${args[0]}:${path}\n`;
      return url.searchParams.get('format') === 'meta'
        ? json({ type: 'commit_file', path, size: Buffer.byteLength(body), attributes: [] })
        : new Response(body);
    }
    return json({}, 404);
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, start: performance.now() });
    await delay(LATENCY);
    return respond(url);
  };
  return { fetcher, requests };
}

const kinds: [string, RegExp][] = [
  ['repository', /^\/2\.0\/repositories\/team\/[^/]+$/],
  ['pullrequests', /\/pullrequests$/],
  ['pullrequests/:id', /\/pullrequests\/\d+$/],
  ['commit', /\/commit\/[a-f0-9]+$/],
  ['statuses', /\/commit\/[a-f0-9]+\/statuses$/],
  ['refs/branches', /\/refs\/branches\//],
  ['merge-base', /\/merge-base\//],
  ['diffstat', /\/diffstat\//],
  ['src', /\/src\//],
];

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'branchline-requests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repos = repositories();
  const bitbucket = simulator(repos);
  const reviews = new ReviewStore(join(directory, 'reviews.json'));
  await reviews.load();
  const project = await reviews.createProject({ repoPath: '/local/project', name: 'Project' });
  const state = new IntegrationStore(join(directory, 'integrations.json'));
  await state.load();
  const account = {
    id: 'bb',
    kind: 'bitbucket' as const,
    label: 'Bitbucket',
    email: 'reviewer@example.invalid',
    accountId: '{reviewer}',
    displayName: 'Reviewer',
    storage: 'session' as const,
    connected: true,
  };
  const connections = {
    list: () => [account],
    credentials: () => ({ info: account, email: account.email, token: 'test-only' }),
    test: async () => account,
  } as unknown as ConnectionManager;
  let service!: IntegrationService;
  const reviewService = new ReviewService(
    reviews,
    async () => {
      throw new Error('Local Git must not run for a remote review.');
    },
    (config) => service.buildSnapshot(config as Review),
  );
  service = new IntegrationService(reviews, reviewService, state, connections, {} as PointerService, {
    createClient: (credentials) => new BitbucketClient(credentials, bitbucket.fetcher),
  });
  const settings = {
    bitbucketConnectionId: 'bb',
    repositories: repos.map((repo) => repo.mapping),
    updateSubmodulePointers: false,
  };
  await service.configureProjectIntegration(project.id, settings);
  /** Requests by kind and wall time of one operation the user waits on. */
  const measure = async <T>(operation: () => Promise<T>) => {
    const first = bitbucket.requests.length;
    const started = performance.now();
    const result = await operation();
    const wall = performance.now() - started;
    const requests = bitbucket.requests.slice(first);
    const counts: Record<string, number> = {};
    for (const request of requests) {
      const kind = kinds.find(([, pattern]) => pattern.test(request.path))?.[0] ?? request.path;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return { result, counts, wall, started, firstRequest: requests[0]?.start - started };
  };
  return { service, project, settings, repos, measure };
}

const trips = (ms: number) => Math.round((ms / LATENCY) * 10) / 10;

test(
  'the PR list, opening its branch review and loading five repositories stay within request and round-trip budgets',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const list = await f.measure(() => f.service.listPullRequests(f.project.id, 'all'));
    assert.deepEqual(
      list.result.map((pr) => [pr.id, pr.sourceHash, pr.targetHash]),
      [[370, f.repos[0].source, f.repos[0].target]],
    );
    assert.deepEqual(list.counts, { pullrequests: 5, commit: 2 });
    assert.ok(list.wall < 2.8 * LATENCY, `list took ${trips(list.wall)} round trips`);

    const open = await f.measure(() =>
      f.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 370 }]),
    );
    assert.deepEqual(open.counts, { 'pullrequests/:id': 1, commit: 2 });
    assert.ok(open.firstRequest < LATENCY / 2, 'opening reads Bitbucket without waiting first');
    assert.ok(open.wall < 2.8 * LATENCY, `opening took ${trips(open.wall)} round trips`);

    let firstFiles = 0;
    const ready: Record<string, number> = {};
    t.after(
      f.service.onRemoteReviewLoadProgress((event) => {
        firstFiles ||= event.result?.snapshot.files.length ? performance.now() : 0;
        for (const step of event.repositories)
          if (['ready', 'failed'].includes(step.phase))
            ready[step.repository.relativePath] ??= performance.now();
      }),
    );
    const load = await f.measure(() => f.service.refreshReview(open.result.id));
    const { snapshot } = load.result;
    assert.equal(snapshot.files.length, 13);
    assert.ok(snapshot.repos.every((repo) => !repo.error));
    assert.deepEqual(snapshot.warnings, [
      'packages/docs: Source branch feature/APP-370 does not exist in this repository.',
    ]);
    assert.deepEqual(load.counts, {
      repository: 5,
      pullrequests: 8,
      'pullrequests/:id': 1,
      commit: 2,
      'refs/branches': 10,
      'merge-base': 4,
      diffstat: 4,
      src: 52,
    });
    assert.ok(load.wall < 8 * LATENCY, `the load took ${trips(load.wall)} round trips`);
    assert.ok(firstFiles - load.started < 8 * LATENCY);
    assert.ok(
      ready['packages/docs'] - load.started < 4 * LATENCY,
      'a repository without the branch is not held behind other downloads',
    );
    t.diagnostic(
      JSON.stringify({
        list: trips(list.wall),
        open: trips(open.wall),
        load: trips(load.wall),
        firstFiles: trips(firstFiles - load.started),
        ready: Object.fromEntries(
          Object.entries(ready).map(([path, at]) => [path, trips(at - load.started)]),
        ),
      }),
    );
  },
);

test(
  'a reopened PR list appears without a request until project or account settings change',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.service.getCachedPullRequests(f.project.id, 'all'), null);
    const listed = await f.service.listPullRequests(f.project.id, 'all');
    const cached = await f.measure(async () => f.service.getCachedPullRequests(f.project.id, 'all'));
    assert.deepEqual(cached.counts, {});
    assert.deepEqual(cached.result?.pullRequests, listed);
    assert.deepEqual(f.service.getCachedPullRequests(f.project.id, 'author')?.pullRequests, []);
    assert.deepEqual(
      f.service.getCachedPullRequests(f.project.id, 'reviewer')?.pullRequests.map((pr) => pr.id),
      [370],
    );
    await f.service.configureProjectIntegration(f.project.id, {
      ...f.settings,
      repositories: f.settings.repositories.slice(1),
    });
    assert.equal(f.service.getCachedPullRequests(f.project.id, 'all'), null, 'repository mappings changed');
    await f.service.listPullRequests(f.project.id, 'all');
    await f.service.testConnection('bb');
    assert.equal(
      f.service.getCachedPullRequests(f.project.id, 'all'),
      null,
      'the account was verified again',
    );
  },
);
