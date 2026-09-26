import * as stylex from '@stylexjs/stylex';
import {
  Check,
  CirclePause,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClosedReviewCheck, ClosedReviewCleanupResult } from '../../../shared/integrations';
import type { Project, Review } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';
import { DialogFooter, DialogIntroduction } from '../../ui/Dialog';
import { Spinner, spinStyle } from '../../ui/Spinner';
import { flushPendingComments } from '../reviews/commentAutosave';
import { IntegrationDialog, IntegrationError, IntegrationLink } from './IntegrationPrimitives';

type CleanupRow = {
  reviewId: string;
  name: string;
  phase: 'checking' | 'checked' | 'removed';
  dataRemoved?: boolean;
  check?: ClosedReviewCheck;
};
const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error);

function rowStatus(row: CleanupRow) {
  if (row.phase === 'checking') return { label: 'Checking…', icon: LoaderCircle, tone: 'checking' };
  if (row.dataRemoved && row.phase !== 'removed')
    return { label: 'Cleanup pending', icon: TriangleAlert, tone: 'warning' };
  if (row.phase === 'removed') return { label: 'Removed', icon: Check, tone: 'removed' };
  if (row.check?.status === 'closed') return { label: 'Ready to remove', icon: Check, tone: 'ready' };
  if (row.check?.status === 'open') return { label: 'Still open', icon: GitPullRequest, tone: 'open' };
  if (row.check?.status === 'blocked')
    return { label: 'Needs attention', icon: CirclePause, tone: 'warning' };
  return { label: 'Could not check', icon: TriangleAlert, tone: 'warning' };
}

export function ClosedReviewCleanup({
  project,
  reviews,
  onClose,
  onRemoved,
}: {
  project: Project;
  reviews: Review[];
  onClose: () => void;
  onRemoved: (result: ClosedReviewCleanupResult) => void;
}) {
  const [rows, setRows] = useState<CleanupRow[]>([]);
  const [scanning, setScanning] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ removed: number; retained: number; metadataPending: number } | null>(
    null,
  );
  const [retryIds, setRetryIds] = useState<string[]>([]);
  const retryIdsRef = useRef(retryIds);
  retryIdsRef.current = retryIds;
  const generation = useRef(0);
  const reviewsRef = useRef(reviews);
  reviewsRef.current = reviews;
  const removedRef = useRef(onRemoved);
  removedRef.current = onRemoved;
  const removalInFlight = useRef(false);

  const scan = useCallback(async () => {
    if (removalInFlight.current) return;
    const current = ++generation.current;
    const candidates = reviewsRef.current.filter(
      (review) => review.remote && review.projectId === project.id,
    );
    setRows((previous) => [
      ...previous.filter(
        (row) =>
          retryIdsRef.current.includes(row.reviewId) &&
          !candidates.some((review) => review.id === row.reviewId),
      ),
      ...candidates.map((review) => ({ reviewId: review.id, name: review.name, phase: 'checking' as const })),
    ]);
    setScanning(true);
    setError('');
    setResult(null);
    try {
      await flushPendingComments();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (current === generation.current && next < candidates.length) {
            const review = candidates[next++];
            let check: ClosedReviewCheck;
            try {
              check = await window.reviewAPI.checkClosedReview(review.id);
            } catch (reason) {
              check = {
                reviewId: review.id,
                name: review.name,
                status: 'unavailable',
                pullRequests: [],
                unpublishedComments: 0,
                reason: message(reason),
              };
            }
            if (current !== generation.current) return;
            setRows((previous) =>
              previous.map((row) => (row.reviewId === review.id ? { ...row, phase: 'checked', check } : row)),
            );
          }
        }),
      );
    } catch (reason) {
      if (current === generation.current) {
        const reasonText = message(reason);
        setError(reasonText);
        setRows((previous) =>
          previous.map((row) => ({
            ...row,
            phase: 'checked',
            check: {
              reviewId: row.reviewId,
              name: row.name,
              status: 'unavailable',
              pullRequests: [],
              unpublishedComments: 0,
              reason: 'Save your pending feedback, then rescan.',
            },
          })),
        );
      }
    } finally {
      if (current === generation.current) setScanning(false);
    }
  }, [project.id]);

  useEffect(() => {
    void scan();
    return () => {
      generation.current++;
    };
  }, [scan]);

  const eligible = rows.filter((row) => row.phase === 'checked' && row.check?.status === 'closed');
  const unpublished = eligible.reduce((count, row) => count + (row.check?.unpublishedComments || 0), 0);
  const checked = rows.filter((row) => row.phase !== 'checking').length;

  async function remove(ids: string[]) {
    if (removalInFlight.current || scanning || !ids.length) return;
    removalInFlight.current = true;
    const current = ++generation.current;
    setRemoving(true);
    setError('');
    try {
      await flushPendingComments();
      const response = await window.reviewAPI.removeClosedReviews(project.id, ids);
      removedRef.current(response);
      if (current !== generation.current) return;
      const removed = new Set(response.removedIds);
      const retained = new Map(response.retained.map((check) => [check.reviewId, check]));
      const savedIds = new Set(response.state.reviews.map((review) => review.id));
      const metadataPending = response.retained.filter((check) => !savedIds.has(check.reviewId)).length;
      setRetryIds((previous) => [
        ...previous.filter((id) => !ids.includes(id)),
        ...response.retained.filter((check) => check.status === 'unavailable').map((check) => check.reviewId),
      ]);
      setRows((previous) =>
        previous.map((row) =>
          removed.has(row.reviewId)
            ? { ...row, phase: 'removed', dataRemoved: true }
            : retained.has(row.reviewId)
              ? {
                  ...row,
                  phase: 'checked',
                  dataRemoved: !savedIds.has(row.reviewId),
                  check: retained.get(row.reviewId),
                }
              : row,
        ),
      );
      setResult({
        removed: response.removedIds.length + metadataPending,
        retained: response.retained.length - metadataPending,
        metadataPending,
      });
    } catch (reason) {
      if (current === generation.current) {
        setError(message(reason));
        setRetryIds((previous) => [...new Set([...previous, ...ids])]);
      }
    } finally {
      removalInFlight.current = false;
      if (current === generation.current) setRemoving(false);
    }
  }

  return (
    <IntegrationDialog title="Clean up closed Bitbucket reviews" wide onClose={onClose} busy={removing}>
      <div {...stylex.props(styles.body)}>
        <DialogIntroduction>
          Check saved reviews in <strong>{project.name}</strong>. Reviews whose pull requests are all closed
          can be removed from Branchline.
        </DialogIntroduction>
        <div {...stylex.props(styles.scanStatus)} role="status">
          <span {...stylex.props(styles.scanLabel)}>
            {removing ? (
              <>
                <Spinner size={14} />
                Rechecking and removing closed reviews…
              </>
            ) : scanning ? (
              <>
                <Spinner size={14} />
                Checking reviews…
              </>
            ) : (
              'Review check complete'
            )}
          </span>
          <span {...stylex.props(styles.scanCount)}>
            {checked} / {rows.length} checked
          </span>
        </div>
        {error && <IntegrationError>{error}</IntegrationError>}
        {result && (
          <p {...stylex.props(styles.result)} role="status">
            Removed {result.removed} {result.removed === 1 ? 'review' : 'reviews'}.
            {result.retained > 0
              ? ` ${result.retained} ${result.retained === 1 ? 'review was' : 'reviews were'} kept after rechecking. See the reasons below.`
              : ''}
            {result.metadataPending > 0
              ? ` Local cleanup still needs attention for ${result.metadataPending} ${result.metadataPending === 1 ? 'review' : 'reviews'}.`
              : ''}
          </p>
        )}
        <ul {...stylex.props(styles.list)} aria-label="Saved Bitbucket reviews">
          {rows.map((row, index) => {
            const status = rowStatus(row);
            const Icon = status.icon;
            const success = status.tone === 'ready' || status.tone === 'removed';
            return (
              <li
                key={row.reviewId}
                {...stylex.props(
                  styles.row,
                  index > 0 && styles.rowFollowing,
                  status.tone === 'warning' && styles.warningRow,
                )}
                aria-label={row.name}
              >
                <div {...stylex.props(styles.rowHeading)}>
                  <Icon
                    size={15}
                    className={`${row.phase === 'checking' ? 'spin ' : ''}${stylex.props(row.phase === 'checking' && spinStyle, success && styles.successTone, status.tone === 'warning' && styles.warningTone).className}`}
                    aria-hidden="true"
                  />
                  <strong {...stylex.props(styles.rowName)}>{row.name}</strong>
                  <span
                    {...stylex.props(
                      styles.rowStatus,
                      success && styles.successTone,
                      status.tone === 'warning' && styles.warningTone,
                    )}
                  >
                    {status.label}
                  </span>
                </div>
                {row.phase !== 'removed' && row.check?.reason && (
                  <p {...stylex.props(styles.reason)}>{row.check.reason}</p>
                )}
                {!!row.check?.unpublishedComments && (
                  <p
                    {...stylex.props(
                      styles.reason,
                      styles.unpublished,
                      row.phase === 'removed' && styles.removedUnpublished,
                    )}
                  >
                    {row.check.unpublishedComments} unpublished{' '}
                    {row.check.unpublishedComments === 1 ? 'comment' : 'comments'}
                    {row.phase === 'removed' || row.dataRemoved
                      ? ' removed from Branchline.'
                      : row.check.status === 'closed'
                        ? ' will be removed from Branchline.'
                        : ' saved in Branchline.'}
                  </p>
                )}
                {!!row.check?.pullRequests.length && (
                  <ul {...stylex.props(styles.pullRequests)} aria-label={`Pull requests for ${row.name}`}>
                    {row.check.pullRequests.map((pr) => (
                      <li key={`${pr.repositoryPath}#${pr.id}`} {...stylex.props(styles.pullRequest)}>
                        <IntegrationLink url={pr.url}>
                          {pr.repoSlug} #{pr.id}
                          <ExternalLink size={11} {...stylex.props(styles.linkIcon)} />
                        </IntegrationLink>
                        <span {...stylex.props(styles.pullRequestState)}>
                          {pr.state.toLowerCase().replaceAll('_', ' ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {!scanning && !eligible.length && !retryIds.length && !result && (
          <p className={`integration-note ${stylex.props(styles['integration-note']).className}`}>
            No closed reviews to remove.
          </p>
        )}
        {eligible.length > 0 && (
          <div {...stylex.props(styles.removalNotice)}>
            <p {...stylex.props(styles.removalParagraph)}>
              Removing a review deletes its local comments and review progress from Branchline. Pull requests,
              comments and branches in Bitbucket stay unchanged.
            </p>
            {unpublished > 0 && (
              <strong {...stylex.props(styles.removalWarning)}>
                {unpublished} unpublished {unpublished === 1 ? 'comment will' : 'comments will'} also be
                removed.
              </strong>
            )}
            <p {...stylex.props(styles.removalParagraph)}>
              Each review is checked again before removal. Reviews that reopen or cannot be verified will be
              kept.
            </p>
          </div>
        )}
      </div>
      <DialogFooter className={stylex.props(styles.footer).className}>
        <Button
          className={stylex.props(styles.rescan).className}
          type="button"
          disabled={scanning || removing || !reviews.length}
          onClick={() => void scan()}
        >
          <RefreshCw size={13} />
          Rescan
        </Button>
        <Button type="button" disabled={removing} onClick={onClose}>
          {result ? 'Done' : 'Cancel'}
        </Button>
        {(retryIds.length > 0 || eligible.length > 0) && (
          <Button
            variant="danger"
            type="button"
            disabled={scanning || removing}
            onClick={() => void remove(retryIds.length ? retryIds : eligible.map((row) => row.reviewId))}
          >
            {removing ? <Spinner size={13} /> : <Trash2 size={13} />}
            {retryIds.length
              ? 'Retry removal'
              : `Remove ${eligible.length} closed ${eligible.length === 1 ? 'review' : 'reviews'}`}
          </Button>
        )}
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
    minHeight: 0,
    overflow: 'auto',
  },
  footer: { flexShrink: 0 },
  scanStatus: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: spacing.xl,
    marginTop: '17px',
    marginRight: '0',
    marginBottom: spacing.lg,
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.compact,
  },
  scanLabel: { display: 'inline-flex', alignItems: 'center', gap: 7 },
  scanCount: { flexShrink: 0, fontFamily: fonts.code, fontSize: typeScale.small },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.lg,
    overflow: 'hidden',
    display: { default: 'block', ':empty': 'none' },
  },
  row: { padding: 15, backgroundColor: colors.surface },
  warningRow: { backgroundColor: colors.warningSurface, color: colors.warningStrong },
  rowFollowing: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  rowHeading: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 9,
    color: colors.textQuiet,
  },
  rowName: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    fontWeight: 550,
    overflowWrap: 'anywhere',
  },
  rowStatus: { maxWidth: 130, fontSize: typeScale.small, textAlign: 'right' },
  successTone: { color: colors.successText },
  warningTone: { color: colors.warningText },
  reason: {
    marginTop: spacing.md,
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '25px',
    color: colors.textMuted,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    overflowWrap: 'anywhere',
  },
  unpublished: { color: colors.warningText },
  removedUnpublished: { color: colors.textMuted },
  pullRequests: {
    listStyle: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: '7px',
    columnGap: spacing.xl,
    marginTop: '10px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '25px',
    padding: 0,
  },
  pullRequest: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    fontSize: typeScale.small,
  },
  pullRequestState: { color: colors.textFaint, fontSize: typeScale.caption },
  linkIcon: { flexShrink: 0 },
  removalNotice: {
    marginTop: 17,
    color: colors.textSubtle,
    fontSize: typeScale.compact,
    lineHeight: 1.75,
  },
  removalParagraph: { marginBlock: spacing.md, marginInline: '0' },
  removalWarning: { color: colors.warningText, fontWeight: 500 },
  result: {
    paddingBlock: '11px',
    paddingInline: '13px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.successBorder,
    borderRadius: 5,
    color: colors.successText,
    backgroundColor: colors.successSurface,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
  },
  rescan: { marginRight: 'auto' },
  'integration-note': {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: 10,
    marginInline: 0,
  },
});
