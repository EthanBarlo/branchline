import * as stylex from '@stylexjs/stylex';
import { ExternalLink, GitPullRequest, RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequest, PullRequestFilter } from '../../../shared/integrations';
import { pullRequestKey } from '../../../shared/integrations';
import type { Project, Review } from '../../../shared/types';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button, IconButton } from '../../ui/Button';
import { DialogFooter, DialogNote } from '../../ui/Dialog';
import { Spinner, spinStyle } from '../../ui/Spinner';
import { flushPendingComments } from '../reviews/diff/commentAutosave';
import { IntegrationDialog } from './IntegrationDialog';
import { IntegrationLink } from './IntegrationLink';
import { Problem } from './IntegrationError';
import { errorMessage as message } from '../../lib/errorMessage';

export function PullRequestsDialog({
  project,
  onClose,
  onOpened,
  onSettings,
}: {
  project: Project;
  onClose: () => void;
  onOpened: (review: Review) => void;
  onSettings: () => void;
}) {
  const [filter, setFilter] = useState<PullRequestFilter>('all');
  const [items, setItems] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const request = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const generation = ++request.current;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await window.reviewAPI.listPullRequests(project.id, filter);
      if (generation === request.current) {
        setItems(result);
        setCheckedAt(new Date().toLocaleTimeString());
      }
    } catch (reason) {
      if (generation === request.current) setError(message(reason));
    } finally {
      if (generation === request.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [project.id, filter]);
  useEffect(() => {
    inFlight.current = false;
    setItems([]);
    void load();
    const visibleRefresh = () => {
      if (!document.hidden) void load();
    };
    const interval = setInterval(visibleRefresh, 60000);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => {
      request.current++;
      clearInterval(interval);
      window.removeEventListener('focus', visibleRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
    };
  }, [load]);
  const groups = useMemo(() => {
    const result = new Map<string, PullRequest[]>();
    for (const item of items) {
      const key = JSON.stringify([item.sourceBranch, item.targetBranch]);
      result.set(key, [...(result.get(key) || []), item]);
    }
    return [...result.entries()];
  }, [items]);
  async function open(key: string, selected: PullRequest[]) {
    setOpening(key);
    setError('');
    try {
      await flushPendingComments();
      onOpened(
        await window.reviewAPI.openPullRequestReview(
          project.id,
          selected.slice(0, 1).map((pr) => ({ repositoryPath: pr.repository.relativePath, prId: pr.id })),
        ),
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setOpening('');
    }
  }
  return (
    <IntegrationDialog title="Pull requests" onClose={onClose} busy={!!opening}>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.prControls)}>
          <div {...stylex.props(styles.segments)} aria-label="Filter pull requests">
            {(['all', 'reviewer', 'author'] as const).map((value) => (
              <button
                type="button"
                key={value}
                {...stylex.props(styles.segmentButton, filter === value && styles.segmentSelected)}
                aria-pressed={filter === value}
                disabled={!!opening}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'All open' : value === 'reviewer' ? 'Needs my review' : 'Created by me'}
              </button>
            ))}
          </div>
          <IconButton
            type="button"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
            disabled={loading || !!opening}
            onClick={() => void load()}
          >
            <RefreshCw
              className={`${loading ? 'spin ' : ''}${stylex.props(loading && spinStyle).className}`}
              size={14}
            />
          </IconButton>
        </div>
        <p {...stylex.props(styles.note)}>
          {project.name} · Opening a PR includes this branch across every mapped repository, including
          repositories without a PR.{checkedAt && ` Checked ${checkedAt}.`}
        </p>
        {error && <Problem>{error}</Problem>}
        {!items.length && (
          <div {...stylex.props(styles.empty)} role="status">
            {loading ? <Spinner size={21} /> : <GitPullRequest size={23} />}
            <strong {...stylex.props(styles.emptyTitle)}>
              {loading ? 'Finding pull requests…' : 'No open pull requests'}
            </strong>
            <span {...stylex.props(styles.emptyDescription)}>
              {loading
                ? 'Reading your project’s Bitbucket repositories.'
                : 'Try another filter or check the project’s repository mappings.'}
            </span>
          </div>
        )}
        <div {...stylex.props(styles.prGroups)}>
          {groups.map(([key, prs]) => {
            const selected = prs.filter((pr) => !pr.unsupportedReason);
            return (
              <section {...stylex.props(styles.prGroup)} key={key}>
                <div {...stylex.props(styles.prGroupHeading)}>
                  <code
                    {...stylex.props(styles.prGroupCode)}
                    title={`${prs[0].sourceBranch} → ${prs[0].targetBranch}`}
                  >
                    {prs[0].sourceBranch}
                    <span {...stylex.props(styles.prGroupArrow)}> → </span>
                    {prs[0].targetBranch}
                  </code>
                  <Button
                    variant="primary"
                    {...stylex.props(styles.prGroupAction)}
                    type="button"
                    disabled={!selected.length || !!opening}
                    onClick={() => void open(key, selected)}
                  >
                    {opening === key ? <Spinner size={12} /> : <GitPullRequest size={12} />}
                    {opening === key ? 'Opening review…' : 'Review branch'}
                  </Button>
                </div>
                {prs.map((pr) => (
                  <div {...stylex.props(styles.prRow)} key={pullRequestKey(pr)}>
                    <GitPullRequest size={14} aria-hidden="true" {...stylex.props(styles.prRowIcon)} />
                    <div {...stylex.props(styles.prRowBody)}>
                      <IntegrationLink url={pr.url} variant="pullRequest">
                        {pr.title}
                        <ExternalLink size={11} {...stylex.props(styles.linkIcon)} />
                      </IntegrationLink>
                      <span {...stylex.props(styles.prRowMeta)}>
                        <code>
                          {pr.repository.relativePath === '.'
                            ? pr.repository.repoSlug
                            : pr.repository.relativePath}
                        </code>{' '}
                        · #{pr.id} · {pr.author.name}
                        {pr.draft ? ' · Draft' : ''}
                      </span>
                      {pr.unsupportedReason && (
                        <span {...stylex.props(styles.inlineError)}>{pr.unsupportedReason}</span>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
      <DialogFooter {...stylex.props(styles.modalChrome)}>
        <DialogNote>Refreshes every minute while visible</DialogNote>
        <Button disabled={!!opening} onClick={onSettings}>
          <Settings2 size={12} />
          Project integrations
        </Button>
        <Button disabled={!!opening} onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </IntegrationDialog>
  );
}

const styles = stylex.create({
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: '0',
    overflow: 'auto',
  },
  prControls: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '15px',
    paddingTop: '20px',
  },
  segments: {
    display: 'flex',
    padding: '3px',
    gap: '3px',
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '5px',
  },
  segmentButton: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.textQuiet,
    borderRadius: radii.sm,
    paddingBlock: spacing.sm,
    paddingInline: '11px',
    fontSize: typeScale.small,
  },
  segmentSelected: { backgroundColor: colors.hover, color: colors.textPrimary },
  note: {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: '10px',
    marginInline: '0',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.lg,
    paddingBlock: '46px',
    paddingInline: spacing.xxl,
    textAlign: 'center',
    color: colors.textQuiet,
  },
  emptyTitle: { color: colors.textSecondary, fontSize: typeScale.base, fontWeight: 500 },
  emptyDescription: { maxWidth: '340px', fontSize: typeScale.compact, lineHeight: 1.8 },
  prGroups: { marginTop: '21px' },
  prGroup: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '5px',
    marginTop: '15px',
    overflow: 'hidden',
  },
  prGroupHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingBlock: '11px',
    paddingInline: spacing.lg,
    backgroundColor: colors.raised,
  },
  prGroupCode: {
    fontSize: typeScale.small,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  prGroupArrow: { color: colors.textFaint },
  prGroupAction: { minHeight: '28px', fontSize: typeScale.small, flexShrink: '0' },
  prRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '11px',
    paddingBlock: '13px',
    paddingInline: spacing.lg,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  prRowIcon: { flexShrink: '0', marginTop: spacing.xxs, color: colors.textQuiet },
  prRowBody: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '0' },
  linkIcon: { flexShrink: '0' },
  prRowMeta: { color: colors.textQuiet, fontSize: typeScale.caption },
  inlineError: { display: 'block', color: colors.dangerText, fontSize: typeScale.small },
  modalChrome: { flexShrink: '0' },
});
