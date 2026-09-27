import type { ReviewFile } from '../../../../shared/types';

/** Resolve against the filtered snapshot, including files beneath collapsed folders. */
export function selectedReviewFiles(
  paths: readonly string[],
  byPath: ReadonlyMap<string, ReviewFile>,
): ReviewFile[] {
  const selected = new Set(paths);
  const directories = paths.filter((path) => path.endsWith('/'));
  const seen = new Set<string>();
  const files: ReviewFile[] = [];
  for (const [path, file] of byPath) {
    if (
      seen.has(file.id) ||
      (!selected.has(path) && !directories.some((directory) => path.startsWith(directory)))
    )
      continue;
    seen.add(file.id);
    files.push(file);
  }
  return files;
}
