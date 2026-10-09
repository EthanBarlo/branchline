import * as stylex from '@stylexjs/stylex';
import { toast } from 'sonner';
import type {
  GitAction,
  GitActionPreview,
  GitActionRow,
  GitOperation,
  GitWorkflowProgress,
  GitWorkflowSnapshot,
} from '../../../shared/git-workflow';
import { colors, radii } from '../../theme/tokens.stylex';

/** The toast that follows one user-started Git action from preview to result. */
export interface GitActionToast {
  id: string;
  action: GitAction;
  branch: string;
  phase: 'preview' | 'run';
  /** Stages this toast reports, which share the progress bar by weight. */
  steps: GitToastStep[];
  onCancel?: () => void;
}

export type GitToastStep = 'fetch' | 'check' | 'run';

export type GitToastStage =
  | { kind: 'preparing' }
  | { kind: 'progress'; progress: GitWorkflowProgress }
  | { kind: 'starting' }
  | { kind: 'running'; done: number; total: number };

const verbs: Record<GitAction, string> = {
  checkout: 'Checking out',
  pull: 'Pulling',
  push: 'Pushing',
  create: 'Creating',
  rename: 'Renaming',
  delete: 'Deleting',
};
const titles: Record<GitAction, string> = {
  create: 'Branch created',
  rename: 'Branch renamed',
  delete: 'Branch deleted',
  checkout: 'Branch checked out',
  pull: 'Pull completed',
  push: 'Push completed',
};
const names: Record<GitAction, string> = {
  checkout: 'Checkout',
  pull: 'Pull',
  push: 'Push',
  create: 'Create branch',
  rename: 'Rename',
  delete: 'Delete branch',
};

export function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

function repositoryLabel(path: string, projectName: string): string {
  return path === '.' ? projectName : path;
}

/** Summarise distinct messages as the first few lines plus a remainder count. */
function summary(lines: string[], limit: number) {
  const unique = [...new Set(lines)];
  return (
    <>
      {unique.slice(0, limit).map((line) => (
        <div key={line}>{line}</div>
      ))}
      {unique.length > limit && <div>+{unique.length - limit} more</div>}
    </>
  );
}

export function previewBranch(preview: GitActionPreview): string {
  const row = preview.rows[0];
  if (!row) return '';
  if (preview.action === 'push' || preview.action === 'pull') return row.branch ?? '';
  const target = preview.action === 'delete' ? row.source : row.destination;
  if (!target) return '';
  return target.remote && preview.action === 'delete' ? `${target.remote}/${target.branch}` : target.branch;
}

const weights: Record<GitToastStep, number> = { fetch: 35, check: 20, run: 45 };
// The bar only moves forward, even when a later stage reports from zero.
const reached = new Map<string, number>();
const finishDelay = 300;

/** The steps a toast covers, from the first action it shows. */
export function gitToastSteps(action: GitAction, previewed: boolean): GitToastStep[] {
  if (!previewed) return ['run'];
  return action === 'push' || action === 'pull' ? ['fetch', 'check', 'run'] : ['check', 'run'];
}

function stagePercent(target: GitActionToast, stage: GitToastStage): number {
  const total = target.steps.reduce((sum, step) => sum + weights[step], 0);
  const at = (step: GitToastStep, fraction: number) => {
    const index = target.steps.indexOf(step);
    if (index < 0) return 0;
    const before = target.steps.slice(0, index).reduce((sum, item) => sum + weights[item], 0);
    return ((before + weights[step] * fraction) / total) * 100;
  };
  const fraction = (done: number, count: number) => (count ? Math.min(done / count, 1) : 1);
  if (stage.kind === 'preparing') return 0;
  if (stage.kind === 'starting') return at('run', 0.1);
  if (stage.kind === 'running') return at('run', 0.1 + 0.9 * fraction(stage.done, stage.total));
  const { stage: step, done, total: count } = stage.progress;
  return at(step === 'fetching' ? 'fetch' : 'check', fraction(done, count));
}

function progressPercent(id: string, value: number): number {
  const percent = Math.max(reached.get(id) ?? 0, value);
  reached.set(id, percent);
  return percent;
}

function ProgressDescription({ text, percent }: { text: string; percent: number }) {
  return (
    <>
      <div>{text}</div>
      <div
        role="progressbar"
        aria-label="Git operation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        {...stylex.props(styles.track)}
      >
        <span {...stylex.props(styles.fill(Math.max(percent, 3)))} />
      </div>
    </>
  );
}

/** Remove a toast whose action ended without a result, such as one handed over to a dialog. */
export function dismissGitToast(id: string): void {
  reached.delete(id);
  toast.dismiss(id);
}

function stageDescription(stage: GitToastStage): string {
  if (stage.kind === 'preparing') return 'Checking repositories…';
  if (stage.kind === 'starting') return 'Starting…';
  if (stage.kind === 'running') return `${stage.done}/${repositoryCount(stage.total)}`;
  const { stage: step, done, total } = stage.progress;
  if (step === 'fetching') return `Fetching remotes · ${done}/${total}`;
  return `Checking ${repositoryCount(total)}…`;
}

function loadingTitle(target: GitActionToast): string {
  return target.branch ? `${verbs[target.action]} ${target.branch}…` : `${verbs[target.action]}…`;
}

/** Fill the bar so the finish is visible, then turn the same toast into its result. */
function finish(id: string, title: string, showResult: () => void): void {
  reached.delete(id);
  toast.loading(title, {
    id,
    description: <ProgressDescription text="Finishing…" percent={100} />,
    action: undefined,
  });
  setTimeout(showResult, finishDelay);
}

export function showGitLoading(target: GitActionToast, stage: GitToastStage): void {
  toast.loading(loadingTitle(target), {
    id: target.id,
    description: (
      <ProgressDescription
        text={stageDescription(stage)}
        percent={progressPercent(target.id, stagePercent(target, stage))}
      />
    ),
    action: target.onCancel ? { label: 'Cancel', onClick: target.onCancel } : undefined,
  });
}

export function showGitNoop(target: GitActionToast, projectName: string): void {
  reached.delete(target.id);
  toast.success(
    target.action === 'push'
      ? 'Nothing to push'
      : target.action === 'checkout'
        ? 'Already checked out'
        : 'Already up to date',
    { id: target.id, description: projectName, action: undefined },
  );
}

function blockerLines(rows: GitActionRow[], projectName: string): string[] {
  return rows.flatMap((row) =>
    row.blockers.map((blocker) => `${repositoryLabel(row.path, projectName)}: ${blocker}`),
  );
}

export function showGitBlocked(
  target: GitActionToast,
  preview: GitActionPreview,
  projectName: string,
  onDetails: () => void,
): void {
  reached.delete(target.id);
  toast.error(`${names[target.action]} blocked`, {
    id: target.id,
    description: summary(blockerLines(preview.rows, projectName), 1),
    duration: 10_000,
    action: { label: 'Details', onClick: onDetails },
  });
}

export function showGitResult(target: GitActionToast, operation: GitOperation, projectName: string): void {
  if (operation.state === 'completed') {
    const count = operation.rows.filter((row) => !row.noop).length;
    // A caveat shared by several repositories is shown once without naming each one.
    const sources = new Map<string, string[]>();
    for (const row of operation.rows)
      for (const warning of row.warnings)
        sources.set(warning, [...(sources.get(warning) ?? []), repositoryLabel(row.path, projectName)]);
    const warnings = [...sources].map(([warning, labels]) =>
      labels.length === 1 ? `${labels[0]}: ${warning}` : warning,
    );
    finish(target.id, loadingTitle(target), () =>
      toast.success(titles[operation.action], {
        id: target.id,
        description: (
          <>
            <div>
              {projectName} · {repositoryCount(count)}
            </div>
            {warnings.length > 0 && summary(warnings, 2)}
          </>
        ),
        duration: warnings.length ? 8_000 : undefined,
        action: undefined,
      }),
    );
    return;
  }
  reached.delete(target.id);
  const failed = operation.rows.filter((row) => row.state === 'failed' || row.state === 'unknown');
  toast.error(
    failed.some((row) => row.state === 'unknown')
      ? `${names[operation.action]} result uncertain`
      : `${names[operation.action]} failed`,
    {
      id: target.id,
      description: summary(
        failed.map((row) => `${repositoryLabel(row.path, projectName)}: ${row.message ?? row.state}`),
        1,
      ),
      duration: 10_000,
      action: undefined,
    },
  );
}

export function showGitError(target: GitActionToast, message: string): void {
  reached.delete(target.id);
  toast.error(`${names[target.action]} failed`, {
    id: target.id,
    description: message,
    duration: 10_000,
    action: undefined,
  });
}

export function showFetchLoading(id: string, projectName: string, done?: number, total?: number): void {
  toast.loading(`Fetching ${projectName}…`, {
    id,
    description: (
      <ProgressDescription
        text={total ? `Fetching remotes · ${done}/${total}` : 'Fetching remotes…'}
        percent={progressPercent(id, total ? ((done ?? 0) / total) * 100 : 0)}
      />
    ),
  });
}

export function showFetchResult(
  id: string,
  projectName: string,
  result: { snapshot?: GitWorkflowSnapshot; error?: string },
): void {
  const repositories = result.snapshot?.repositories ?? [];
  const errors = repositories
    .filter((repo) => repo.fetchError)
    .map((repo) => `${repositoryLabel(repo.path, projectName)}: ${repo.fetchError}`);
  if (result.error || errors.length) {
    reached.delete(id);
    toast.error('Fetch failed', {
      id,
      description: result.error ?? summary(errors, 1),
      duration: 10_000,
    });
    return;
  }
  const behind = repositories.filter((repo) => repo.incoming);
  const incoming = behind.reduce((total, repo) => total + (repo.incoming ?? 0), 0);
  finish(id, `Fetching ${projectName}…`, () =>
    toast.success('Fetch completed', {
      id,
      description: incoming
        ? `${incoming} incoming ${incoming === 1 ? 'commit' : 'commits'} · ${repositoryCount(behind.length)}`
        : `${projectName} is up to date`,
    }),
  );
}

const styles = stylex.create({
  track: {
    width: '100%',
    height: 4,
    marginTop: 8,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.hover,
  },
  fill: (percent: number) => ({
    display: 'block',
    width: `${percent}%`,
    height: '100%',
    backgroundColor: colors.accent,
    transition: { default: 'width .25s ease-out', '@media (prefers-reduced-motion: reduce)': 'none' },
  }),
});
