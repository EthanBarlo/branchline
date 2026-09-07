import { prepareFileTreeInput } from '@pierre/trees';
import type { ReviewFile } from '../../shared/types';

export function reviewFilePath(file: ReviewFile): string {
  const prefix = file.repoRelativePath === '.' ? '' : file.repoRelativePath.replace(/\/$/, '');
  return prefix ? `${prefix}/${file.path}` : file.path;
}

/** Use the explorer's own directories-first, natural path order. */
export function orderReviewFiles(files: readonly ReviewFile[]): ReviewFile[] {
  const byPath = new Map(files.map(file => [reviewFilePath(file), file]));
  return prepareFileTreeInput([...byPath.keys()]).paths.flatMap(path => {
    const file = byPath.get(path);
    return file ? [file] : [];
  });
}
