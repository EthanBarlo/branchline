import type { ReviewComment, ReviewFile } from '../../../../shared/types';
export interface ReviewTreeProps {
  theme: 'light' | 'dark';
  files: ReviewFile[];
  selectedFileId: string | null;
  visibleFileId?: string | null;
  approvals: Record<string, string>;
  reviewedVersions: Record<string, string>;
  historicalFiles?: Record<string, string>;
  comments: ReviewComment[];
  onSelect: (id: string) => void;
  onReviewFiles: (files: ReviewFile[], approved: boolean) => Promise<void>;
  reviewBusy: boolean;
  loading?: boolean;
  onOrderChange: (fileIds: string[]) => void;
  filter: 'all' | 'unreviewed' | 'commented';
  query: string;
}
