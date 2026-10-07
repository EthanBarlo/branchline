import type { ReviewComment, ReviewSnapshot } from '../../../shared/types';
import type {
  CommentPublication,
  FeedbackPreview,
  InlinePayload,
  PublishFeedbackOptions,
  PublishFeedbackResult,
  PublishedValue,
  PullRequest,
  ReanchorInput,
  RemoteAnchor,
  RemoteComment,
  RemoteReviewState,
} from '../../../shared/integrations';
import { branchReviewKey, pullRequestKey } from '../../../shared/integrations';
import type { BranchReviewService } from './branch-review-service';
import type { BitbucketClient } from './bitbucket-client';
import { IntegrationStore } from '../integration-store';
import { ReviewStore } from '../../reviews/review-store';
import { mapConcurrent } from '../concurrency';

const same = (a: PublishedValue | undefined, b: PublishedValue | undefined) =>
  !!a && !!b && a.body === b.body && a.resolved === b.resolved && a.deleted === b.deleted;
const actual = (comment: RemoteComment): PublishedValue => ({
  body: comment.body,
  resolved: comment.resolved,
  deleted: comment.deleted,
});
const desired = (comment: ReviewComment | undefined, publication: CommentPublication): PublishedValue =>
  comment
    ? { body: comment.body, resolved: comment.resolved, deleted: false }
    : {
        body: publication.acknowledged?.body ?? publication.intended?.body ?? '',
        resolved: publication.acknowledged?.resolved ?? false,
        deleted: true,
      };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const knownRejection = (error: unknown) => {
  const status = (error as { status?: number })?.status;
  return !!status && status >= 400 && status < 500 && status !== 408;
};

export function inlinePayload(anchor: RemoteAnchor, body: string): InlinePayload {
  const inline: InlinePayload['inline'] = { path: anchor.path };
  if (anchor.lineStart > 0) {
    if (anchor.side === 'additions') {
      inline.to = anchor.lineEnd;
      if (anchor.lineStart !== anchor.lineEnd) inline.start_to = anchor.lineStart;
    } else {
      inline.from = anchor.lineEnd;
      if (anchor.lineStart !== anchor.lineEnd) inline.start_from = anchor.lineStart;
    }
  }
  return { content: { raw: body }, inline };
}
function matchesAnchor(comment: RemoteComment, anchor: RemoteAnchor): boolean {
  const { inline } = inlinePayload(anchor, '');
  return (
    comment.path === inline.path &&
    (comment.from ?? undefined) === inline.from &&
    (comment.to ?? undefined) === inline.to &&
    (comment.startFrom ?? comment.from) === (inline.start_from ?? inline.from) &&
    (comment.startTo ?? comment.to) === (inline.start_to ?? inline.to)
  );
}
function changeAction(
  publication: CommentPublication,
  value: PublishedValue,
): NonNullable<CommentPublication['action']> | null {
  if (!publication.remoteId) return value.deleted || value.resolved ? null : 'create';
  if (value.deleted) return publication.acknowledged?.deleted ? null : 'delete';
  if (publication.acknowledged?.deleted) return null;
  if (value.body !== publication.acknowledged?.body) return 'update';
  if (value.resolved !== publication.acknowledged?.resolved) return value.resolved ? 'resolve' : 'reopen';
  return null;
}

/** Caller serializes remote actions per review. Local edits may proceed after publication intent freezes. */
export class PublicationService {
  constructor(
    private readonly reviews: ReviewStore,
    private readonly state: IntegrationStore,
    private readonly client: (id: string) => BitbucketClient,
    private readonly snapshot: (id: string) => ReviewSnapshot | undefined,
    private readonly accountId: (id: string) => string,
    private readonly branches?: Pick<BranchReviewService, 'preflight' | 'ensurePullRequests'>,
  ) {}

  private binding(id: string): RemoteReviewState {
    const value = this.state.review(id);
    if (!value) throw new Error('Open a Bitbucket PR review first.');
    return value;
  }
  private pr(binding: RemoteReviewState, anchor: RemoteAnchor): PullRequest {
    const pr = binding.pullRequests.find((pr) => pullRequestKey(pr) === anchor.prKey);
    if (!pr) throw new Error('The comment is no longer linked to a PR in this review.');
    return pr;
  }
  private makeAnchor(
    id: string,
    comment: Pick<ReviewComment, 'fileId' | 'fingerprint' | 'side' | 'lineStart' | 'lineEnd'>,
  ): RemoteAnchor {
    const binding = this.binding(id);
    const snapshot = this.snapshot(id);
    const file = snapshot?.files.find((file) => file.id === comment.fileId);
    if (!file || file.fingerprint !== comment.fingerprint || file.unavailable)
      throw new Error('Refresh the PR and select the current file version before publishing this comment.');
    if (comment.side !== 'additions' && comment.side !== 'deletions')
      throw new Error('Choose a valid comment side.');
    if (
      !Number.isInteger(comment.lineStart) ||
      !Number.isInteger(comment.lineEnd) ||
      comment.lineStart < 0 ||
      comment.lineEnd < comment.lineStart ||
      (comment.lineStart === 0 && comment.lineEnd !== 0)
    )
      throw new Error('Choose a valid line range.');
    const content = comment.side === 'additions' ? file.newContent : file.oldContent;
    const lineCount = content === null ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    if (comment.lineStart > 0 && (file.binary || file.tooLarge || comment.lineEnd > lineCount))
      throw new Error('The selected lines are not available in this PR file.');
    const pr = binding.pullRequests.find((pr) => pr.repository.relativePath === file.repoRelativePath);
    const row = binding.repositories?.find((row) => row.repository.relativePath === file.repoRelativePath);
    const comparison = row ?? pr;
    if (!comparison?.sourceHash || !comparison.targetHash || row?.status === 'unavailable')
      throw new Error('This file is not part of an available branch comparison.');
    return {
      prKey: pr ? pullRequestKey(pr) : branchReviewKey(file.repoRelativePath),
      sourceHash: comparison.sourceHash,
      targetHash: comparison.targetHash,
      path: file.remotePath ?? file.path,
      side: comment.side,
      lineStart: comment.lineStart,
      lineEnd: comment.lineEnd,
      fingerprint: file.fingerprint,
    };
  }

  async capture(id: string): Promise<void> {
    const binding = this.state.review(id);
    if (!binding) return;
    const additions: CommentPublication[] = [];
    for (const comment of this.reviews.getReview(id).comments) {
      if (binding.publications[comment.id]) continue;
      // A stale draft must remain saved even when it cannot be anchored remotely.
      let anchor: RemoteAnchor;
      try {
        anchor = this.makeAnchor(id, comment);
      } catch {
        continue;
      }
      additions.push({ commentId: comment.id, anchor, state: 'draft', backup: comment });
    }
    if (additions.length)
      await this.state.updateReview(id, (r) => {
        for (const publication of additions) r.publications[publication.commentId] ??= publication;
      });
  }

  async reconcile(
    id: string,
    commit: <T>(action: () => Promise<T>) => Promise<T> = (action) => action(),
  ): Promise<void> {
    let binding = this.binding(id);
    if (Object.values(binding.publications).some((p) => p.state === 'sending')) {
      await commit(() =>
        this.state.updateReview(id, (r) => {
          for (const p of Object.values(r.publications))
            if (p.state === 'sending') {
              p.state = 'unknown';
              p.error = 'Delivery is unknown. Reconcile the remote result before retrying.';
            }
        }),
      );
      binding = this.binding(id);
    }
    const client = this.client(binding.connectionId);
    const userId = this.accountId(binding.connectionId);
    // Saved values are captured before each read so a user choice made during it still wins.
    const reads = binding.pullRequests
      .map((pr) => ({
        pr,
        pubs: Object.values(binding.publications).filter(
          (p) => p.anchor.prKey === pullRequestKey(pr) && (p.remoteId || p.state === 'unknown'),
        ),
      }))
      .filter((read) => read.pubs.length);
    const lists = await mapConcurrent(reads, 4, (read) => client.listComments(read.pr));
    for (const [index, { pubs }] of reads.entries()) {
      const remote = lists[index];
      for (const saved of pubs)
        await commit(async () => {
          let publication = this.binding(id).publications[saved.commentId];
          // A user may explicitly resolve delivery or a conflict during this read.
          // Its older response cannot undo that choice; a later sync can retry.
          if (JSON.stringify(publication) !== JSON.stringify(saved)) return;
          if (publication.state === 'unknown' && !publication.remoteId && publication.action === 'create') {
            const matches = remote.filter(
              (c) =>
                c.authorId === userId &&
                !c.deleted &&
                !publication.baselineIds?.includes(c.id) &&
                c.body === publication.intended?.body &&
                matchesAnchor(c, publication.anchor) &&
                (!c.createdAt || Date.parse(c.createdAt) >= Date.parse(publication.startedAt ?? '') - 1000),
            );
            if (matches.length !== 1) return;
            const found = matches[0];
            await this.state.updateReview(id, (r) =>
              Object.assign(r.publications[saved.commentId], {
                remoteId: found.id,
                authorId: found.authorId,
                url: found.url,
                acknowledged: actual(found),
                state: 'synced',
                error: undefined,
              }),
            );
            publication = this.binding(id).publications[saved.commentId];
          }
          if (!publication.remoteId) return;
          const found = remote.find((c) => c.id === publication.remoteId);
          if (found && found.authorId !== userId) {
            await this.state.updateReview(id, (r) =>
              Object.assign(r.publications[saved.commentId], {
                state: 'failed',
                error: 'Reconnect the account that owns this comment before changing it.',
              }),
            );
            return;
          }
          const remoteValue = found
            ? actual(found)
            : {
                body: publication.acknowledged?.body ?? '',
                resolved: publication.acknowledged?.resolved ?? false,
                deleted: true,
              };
          const local = this.reviews.getReview(id).comments.find((c) => c.id === publication.commentId);
          const localValue = desired(local, publication);
          if (same(remoteValue, publication.acknowledged)) {
            if (
              publication.state === 'unknown' ||
              publication.state === 'conflict' ||
              (publication.state === 'failed' && same(localValue, remoteValue))
            )
              await this.state.updateReview(id, (r) =>
                Object.assign(r.publications[saved.commentId], {
                  state: same(localValue, remoteValue) ? 'synced' : 'draft',
                  error: undefined,
                  remote: undefined,
                }),
              );
            return;
          }
          if (!same(localValue, publication.acknowledged) && !same(localValue, remoteValue)) {
            await this.state.updateReview(id, (r) =>
              Object.assign(r.publications[saved.commentId], {
                state: 'conflict',
                remote: remoteValue,
                error: 'This comment changed in Bitbucket while you had local changes.',
              }),
            );
            return;
          }
          if (local) {
            if (remoteValue.deleted) await this.reviews.deleteComment(id, local.id);
            else
              await this.reviews.updateComment(id, local.id, {
                body: remoteValue.body,
                resolved: remoteValue.resolved,
              });
          }
          await this.state.updateReview(id, (r) =>
            Object.assign(r.publications[saved.commentId], {
              acknowledged: remoteValue,
              state: 'synced',
              error: undefined,
              remote: undefined,
            }),
          );
        });
    }
  }

  /** One live read per PR replaces rebuilding the whole snapshot before publishing. */
  private async drift(id: string): Promise<Map<string, string>> {
    const binding = this.binding(id);
    const client = this.client(binding.connectionId);
    const problems = new Map<string, string>();
    const open = binding.pullRequests.filter((pr) => {
      if (pr.state === 'OPEN') return true;
      problems.set(pullRequestKey(pr), `PR #${pr.id} is no longer open.`);
      return false;
    });
    const latest = await mapConcurrent(open, 4, (pr) => client.getPullRequest(pr.repository, pr.id));
    for (const [index, pr] of open.entries()) {
      if (latest[index].state !== 'OPEN') problems.set(pullRequestKey(pr), `PR #${pr.id} is no longer open.`);
      else if (latest[index].sourceHash !== pr.sourceHash)
        problems.set(
          pullRequestKey(pr),
          `New commits were pushed to PR #${pr.id}. Refresh the review before publishing.`,
        );
    }
    if (open.length)
      await this.state.updateReview(id, (r) => {
        for (const [index, pr] of open.entries()) {
          const saved = r.pullRequests.find((value) => pullRequestKey(value) === pullRequestKey(pr));
          if (!saved) continue;
          saved.participants = latest[index].participants;
          // The target tip moves whenever its branch merges other work. The reviewed diff
          // keeps its merge base, so adopt it as a refresh would; drafts anchored to the
          // old tip are still asked to move to current lines.
          if (problems.has(pullRequestKey(pr)) || saved.targetHash === latest[index].targetHash) continue;
          saved.targetHash = latest[index].targetHash;
          const row = r.repositories?.find(
            (value) => value.repository.relativePath === pr.repository.relativePath && value.prId === pr.id,
          );
          if (row) row.targetHash = latest[index].targetHash;
        }
      });
    return problems;
  }

  /** `remote: false` lists drafts without network reads; publishing always reads Bitbucket. */
  async preview(id: string, options: { remote?: boolean; drift?: boolean } = {}): Promise<FeedbackPreview> {
    await this.capture(id);
    let drift = new Map<string, string>();
    if (options.remote !== false)
      [, drift] = await Promise.all([this.reconcile(id), options.drift === false ? drift : this.drift(id)]);
    const binding = this.binding(id);
    const review = this.reviews.getReview(id);
    const items: FeedbackPreview['items'] = [];
    const blockers: string[] = [];
    for (const comment of review.comments)
      if (!binding.publications[comment.id] && !comment.resolved) {
        items.push({
          commentId: comment.id,
          repositoryPath: comment.repoRelativePath,
          prId: 0,
          path: comment.path,
          side: comment.side,
          lineStart: comment.lineStart,
          lineEnd: comment.lineEnd,
          body: comment.body,
          action: 'create',
          state: 'failed',
          error: 'Select the current PR lines to re-anchor this draft.',
        });
        blockers.push('Some drafts need to be re-anchored on the current PR diff.');
      }
    for (const p of Object.values(binding.publications)) {
      const comment = review.comments.find((c) => c.id === p.commentId);
      const value = desired(comment, p);
      const action = changeAction(p, value);
      if (!action && !['unknown', 'conflict', 'failed'].includes(p.state)) continue;
      const pr = binding.pullRequests.find((pr) => pullRequestKey(pr) === p.anchor.prKey);
      const row = binding.repositories?.find(
        (row) =>
          branchReviewKey(row.repository.relativePath) === p.anchor.prKey ||
          pr?.repository.relativePath === row.repository.relativePath,
      );
      const comparison = row ?? pr;
      // Known rejections may be retried after correcting their cause.
      let error = p.state === 'unknown' || p.state === 'conflict' ? p.error : undefined;
      if (!comparison || row?.status === 'unavailable' || row?.status === 'missing-branch')
        error = row?.error ?? 'The comment’s branch is unavailable. Refresh the review before publishing.';
      else if (pr && drift.has(pullRequestKey(pr))) error = drift.get(pullRequestKey(pr));
      else if (
        action === 'create' &&
        (p.anchor.sourceHash !== comparison.sourceHash || p.anchor.targetHash !== comparison.targetHash)
      )
        error = 'The PR changed. Move this draft to the current lines before publishing.';
      if (row?.creation?.state === 'unknown' || row?.creation?.state === 'sending')
        error = 'PR creation is unconfirmed. Check Bitbucket and refresh before publishing.';
      if (p.authorId && p.authorId !== this.accountId(binding.connectionId))
        error = 'This comment belongs to another Bitbucket account.';
      if (error) blockers.push(error);
      if (p.state === 'unknown' && !error)
        blockers.push('A previous delivery is unknown. Check Bitbucket before retrying.');
      items.push({
        commentId: p.commentId,
        repositoryPath: comparison?.repository.relativePath ?? p.backup?.repoRelativePath ?? '.',
        prId: pr?.id ?? 0,
        createsPullRequest: !pr && row?.status === 'changes',
        path: p.anchor.path,
        side: p.anchor.side,
        lineStart: p.anchor.lineStart,
        lineEnd: p.anchor.lineEnd,
        body: value.body,
        action: action ?? p.action ?? 'update',
        state: action && p.state === 'synced' ? 'draft' : p.state,
        error: error ?? p.error,
        remote: p.remote,
      });
    }
    return { items, blockers: [...new Set(blockers)] };
  }

  async publish(
    id: string,
    onPrepared: () => void = () => {},
    options: PublishFeedbackOptions = {},
  ): Promise<PublishFeedbackResult> {
    // Each PR is checked once below, before its first write, so skip the preview's drift read.
    const preview = await this.preview(id, { drift: false });
    if (preview.blockers.length) throw new Error(preview.blockers.join('\n'));
    if (this.branches && preview.items.length) {
      const blockers = await this.branches.preflight(id);
      if (blockers.length) throw new Error(blockers.join('\n'));
      const creates = preview.items
        .filter((item) => item.createsPullRequest)
        .map((item) => item.repositoryPath);
      if (creates.length) {
        await this.branches.ensurePullRequests(id, creates, { checked: true });
        const after = await this.branches.preflight(id);
        if (after.length) throw new Error(after.join('\n'));
      }
    }
    const binding = this.binding(id);
    const client = this.client(binding.connectionId);
    const account = this.accountId(binding.connectionId);
    // Freeze intent after autosave; later editor changes belong to a subsequent batch.
    const batch = preview.items.map((item) => {
      const publication = binding.publications[item.commentId];
      return {
        commentId: item.commentId,
        value: desired(
          this.reviews.getReview(id).comments.find((c) => c.id === item.commentId),
          publication,
        ),
      };
    });
    onPrepared();
    // One live check per PR before its first write. Its comment list is the baseline that
    // lets an uncertain create be matched later without mistaking an older comment for it.
    const gates = new Map<string, Promise<number[]>>();
    const gate = (pr: PullRequest) => {
      const key = pullRequestKey(pr);
      let pending = gates.get(key);
      if (!pending) {
        pending = Promise.all([client.getPullRequest(pr.repository, pr.id), client.listComments(pr)]).then(
          ([latest, comments]) => {
            if (latest.sourceHash !== pr.sourceHash || latest.targetHash !== pr.targetHash)
              throw new Error('The PR changed. Refresh and review its current lines before publishing.');
            if (latest.state !== 'OPEN') throw new Error('This PR is no longer open.');
            return comments.map((c) => c.id);
          },
        );
        gates.set(key, pending);
      }
      return pending;
    };
    const created = new Map<string, number[]>();
    const delivered = new Map<string, { pr: PullRequest; commentIds: string[]; feedback: boolean }>();
    // Each comment has its own durable receipt. Steps on one comment remain
    // ordered; independent comments may use the network at the same time.
    let stopped = false;
    await mapConcurrent(batch, 3, async (entry) => {
      if (stopped) return;
      let publication = this.binding(id).publications[entry.commentId];
      const pr = this.pr(binding, publication.anchor);
      const key = pullRequestKey(pr);
      let feedback = false;
      let changed = false;
      try {
        for (let step = 0; step < 3; step++) {
          publication = this.binding(id).publications[entry.commentId];
          const action = changeAction(publication, entry.value);
          if (!action) break;
          if (publication.authorId && publication.authorId !== account)
            throw new Error('Only the connected author can change this comment.');
          const baseline = await gate(pr);
          if (
            action === 'create' &&
            (publication.anchor.sourceHash !== pr.sourceHash ||
              publication.anchor.targetHash !== pr.targetHash)
          )
            throw new Error('The PR changed. Refresh and review its current lines before publishing.');
          await this.state.updateReview(id, (r) =>
            Object.assign(r.publications[entry.commentId], {
              state: 'sending',
              action,
              intended: entry.value,
              startedAt: new Date().toISOString(),
              baselineIds: action === 'create' ? [...baseline, ...(created.get(key) ?? [])] : undefined,
              error: undefined,
            }),
          );
          try {
            let result: RemoteComment | undefined;
            if (action === 'create')
              result = await client.createComment(pr, inlinePayload(publication.anchor, entry.value.body));
            else if (action === 'update')
              result = await client.updateComment(pr, publication.remoteId!, entry.value.body);
            else if (action === 'delete') await client.deleteComment(pr, publication.remoteId!);
            else await client.resolveComment(pr, publication.remoteId!, action === 'resolve');
            if (result && action === 'create') created.set(key, [...(created.get(key) ?? []), result.id]);
            await this.state.updateReview(id, (r) => {
              const p = r.publications[entry.commentId];
              if (result) {
                p.remoteId = result.id;
                p.authorId = result.authorId;
                p.url = result.url;
              }
              const ack = p.acknowledged ?? { body: entry.value.body, resolved: false, deleted: false };
              p.acknowledged = {
                body: action === 'create' || action === 'update' ? entry.value.body : ack.body,
                resolved: action === 'resolve' ? true : action === 'reopen' ? false : ack.resolved,
                deleted: action === 'delete',
              };
              p.state = same(p.acknowledged, entry.value) ? 'synced' : 'draft';
              p.error = undefined;
            });
            changed = true;
            feedback ||= action === 'create' || action === 'update';
          } catch (error) {
            await this.state.updateReview(id, (r) =>
              Object.assign(r.publications[entry.commentId], {
                state: knownRejection(error) ? 'failed' : 'unknown',
                error: errorText(error),
              }),
            );
            stopped = true;
            return;
          }
        }
      } catch (error) {
        await this.state.updateReview(id, (r) => {
          const p = r.publications[entry.commentId];
          p.error = errorText(error);
          if (p.state !== 'unknown') p.state = 'failed';
        });
        stopped = true;
        return;
      }
      if (!changed) return;
      const touched = delivered.get(key) ?? { pr, commentIds: [], feedback: false };
      touched.commentIds.push(entry.commentId);
      touched.feedback ||= feedback;
      delivered.set(key, touched);
    });
    // Confirm each changed PR still matches the reviewed revision after its writes.
    const warnings: string[] = [];
    const confirmed = await Promise.all(
      [...delivered.values()].map(async (touched) => {
        try {
          const latest = await client.getPullRequest(touched.pr.repository, touched.pr.id);
          if (latest.sourceHash !== touched.pr.sourceHash || latest.targetHash !== touched.pr.targetHash)
            throw new Error('The PR changed. Refresh and review its current lines before publishing.');
          if (latest.state !== 'OPEN') throw new Error('This PR is no longer open.');
          return { ...touched, latest };
        } catch (error) {
          await this.state.updateReview(id, (r) => {
            for (const commentId of touched.commentIds) {
              const p = r.publications[commentId];
              p.error = errorText(error);
              if (p.state !== 'unknown') p.state = 'failed';
            }
          });
          stopped = true;
          return null;
        }
      }),
    );
    const requested = new Set<string>();
    const requestedChanges: number[] = [];
    if (options.requestChanges) {
      // Bitbucket does not let authors review their own PR.
      const targets = confirmed.filter(
        (touched): touched is NonNullable<typeof touched> =>
          !!touched?.feedback && touched.latest.author.id !== account,
      );
      if (stopped && targets.length)
        warnings.push('Changes were not requested because some feedback did not publish.');
      else
        await Promise.all(
          targets.map(async ({ pr, latest }) => {
            if (latest.participants.some((p) => p.id === account && p.changesRequested)) {
              requestedChanges.push(pr.id);
              return;
            }
            try {
              await client.requestChanges(pr);
              requested.add(pullRequestKey(pr));
              requestedChanges.push(pr.id);
            } catch (error) {
              warnings.push(
                `Feedback was published, but requesting changes on PR #${pr.id} failed: ${errorText(error)}`,
              );
            }
          }),
        );
    }
    if (confirmed.some(Boolean))
      await this.state.updateReview(id, (r) => {
        for (const touched of confirmed) {
          if (!touched) continue;
          const key = pullRequestKey(touched.pr);
          const saved = r.pullRequests.find((value) => pullRequestKey(value) === key);
          if (!saved) continue;
          saved.participants = touched.latest.participants.filter(
            (p) => !requested.has(key) || p.id !== account,
          );
          if (requested.has(key))
            saved.participants.push({ id: account, approved: false, changesRequested: true });
        }
      });
    return {
      state: this.binding(id),
      preview: await this.preview(id, { remote: false }),
      requestedChanges: requestedChanges.sort((a, b) => a - b),
      warnings,
    };
  }

  async reanchor(id: string, commentId: string, input: ReanchorInput) {
    const binding = this.binding(id);
    const publication = binding.publications[commentId];
    if (publication?.remoteId || publication?.state === 'unknown' || publication?.state === 'sending')
      throw new Error(
        'Published or uncertain comments keep their original anchor. Create a new comment on the current lines.',
      );
    const anchor = this.makeAnchor(id, input);
    const file = this.snapshot(id)!.files.find((f) => f.id === input.fileId)!;
    const content = input.side === 'additions' ? file.newContent : file.oldContent;
    const lines = content?.split('\n') ?? [];
    const review = await this.reviews.reanchorComment(id, commentId, {
      fileId: file.id,
      repoRelativePath: file.repoRelativePath,
      path: input.side === 'deletions' ? (file.oldPath ?? file.path) : file.path,
      side: input.side,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      fingerprint: file.fingerprint,
      context: input.lineStart
        ? lines
            .slice(input.lineStart - 1, input.lineEnd)
            .join('\n')
            .slice(0, 20000)
        : '',
      contextBefore: input.lineStart
        ? lines.slice(Math.max(0, input.lineStart - 4), input.lineStart - 1).join('\n')
        : '',
      contextAfter: input.lineStart ? lines.slice(input.lineEnd, input.lineEnd + 3).join('\n') : '',
    });
    await this.state.updateReview(id, (r) => {
      r.publications[commentId] = {
        commentId,
        anchor,
        state: 'draft',
        backup: review.comments.find((c) => c.id === commentId),
      };
    });
    return review;
  }

  async resolveConflict(id: string, commentId: string, choice: 'local' | 'remote') {
    if (choice !== 'local' && choice !== 'remote') throw new Error('Choose which comment version to keep.');
    const p = this.binding(id).publications[commentId];
    if (!p?.remote || p.state !== 'conflict')
      throw new Error('Refresh feedback before resolving this conflict.');
    if (choice === 'local' && p.remote.deleted)
      throw new Error(
        'The remote comment was deleted. Accept its deletion, then create a new comment if needed.',
      );
    const local = this.reviews.getReview(id).comments.find((c) => c.id === commentId);
    if (choice === 'remote' && local) {
      if (p.remote.deleted) await this.reviews.deleteComment(id, commentId);
      else
        await this.reviews.updateComment(id, commentId, { body: p.remote.body, resolved: p.remote.resolved });
    }
    if (choice === 'remote' && !local && !p.remote.deleted && p.backup) {
      await this.reviews.addComment(id, { ...p.backup, body: p.remote.body });
      await this.reviews.updateComment(id, commentId, { resolved: p.remote.resolved });
    }
    await this.state.updateReview(id, (r) =>
      Object.assign(r.publications[commentId], {
        acknowledged: p.remote,
        remote: undefined,
        error: undefined,
        state: choice === 'local' ? 'draft' : 'synced',
      }),
    );
    return this.reviews.getReview(id);
  }

  /** Explicit user reconciliation only; never invoked by automatic retries. */
  async resolveUnknown(id: string, commentId: string, remoteId: number | null): Promise<RemoteReviewState> {
    await this.reconcile(id);
    const binding = this.binding(id);
    const p = binding.publications[commentId];
    if (p?.state === 'synced') return binding;
    if (!p || p.state !== 'unknown' || p.remoteId || p.action !== 'create')
      throw new Error('This comment does not need manual creation reconciliation.');
    const comments = await this.client(binding.connectionId).listComments(this.pr(binding, p.anchor));
    const candidates = comments.filter(
      (c) =>
        c.authorId === this.accountId(binding.connectionId) &&
        !c.deleted &&
        matchesAnchor(c, p.anchor) &&
        c.body === p.intended?.body &&
        !p.baselineIds?.includes(c.id),
    );
    if (remoteId === null) {
      if (candidates.length)
        throw new Error(
          'Matching comments exist in Bitbucket. Link the correct comment ID instead of posting again.',
        );
      return this.state.updateReview(id, (r) =>
        Object.assign(r.publications[commentId], {
          state: 'draft',
          action: undefined,
          intended: undefined,
          startedAt: undefined,
          baselineIds: undefined,
          error: undefined,
        }),
      );
    }
    if (!Number.isSafeInteger(remoteId) || remoteId < 1) throw new Error('Enter the Bitbucket comment ID.');
    const match = candidates.find((c) => c.id === remoteId);
    if (!match)
      throw new Error('That comment does not match the connected author, original lines and published text.');
    return this.state.updateReview(id, (r) =>
      Object.assign(r.publications[commentId], {
        remoteId: match.id,
        authorId: match.authorId,
        url: match.url,
        acknowledged: actual(match),
        state: 'synced',
        error: undefined,
      }),
    );
  }
}
