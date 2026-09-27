import type { Review, ReviewFile } from '../../../../shared/types';
import { reviewContextKey } from '../../../../shared/types';
import { orderReviewFiles } from '../tree/reviewFileOrder';

export const reviewViewKey = (review: Review) => `${review.id}:${reviewContextKey(review)}`;
export const isApproved = (review: Review, file: ReviewFile) =>
  review.approvals[file.id] === file.fingerprint;

export function nextPendingFile(
  files: ReviewFile[],
  review: Review,
  afterId?: string,
  explorerIds?: string[],
) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const findNext = (ids: string[]) => {
    const start = ids.indexOf(afterId || '');
    for (const id of [...ids.slice(start + 1), ...ids.slice(0, start + 1)]) {
      const file = byId.get(id);
      if (file && !isApproved(review, file)) return file;
    }
  };
  const visible = explorerIds && findNext(explorerIds);
  return visible || findNext(orderReviewFiles(files).map((file) => file.id));
}

export const approvalHistoryKey = 'branchline.reviewedVersions';

export function readApprovalHistory(): Record<string, Record<string, string>> {
  try {
    const saved = JSON.parse(localStorage.getItem(approvalHistoryKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, files]) =>
          files &&
          typeof files === 'object' &&
          !Array.isArray(files) &&
          Object.values(files).every((value) => typeof value === 'string'),
      ),
    ) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

export function mergeReview(previous: Review[], incoming: Review): Review[] {
  const index = previous.findIndex((review) => review.id === incoming.id);
  if (index === -1) return [incoming, ...previous];
  if (JSON.stringify(previous[index]) === JSON.stringify(incoming)) return previous;
  return previous.map((review) => (review.id === incoming.id ? incoming : review));
}
