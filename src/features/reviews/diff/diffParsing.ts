import { parseDiffFromFile, processFile, type DiffFileInput, type FileDiffMetadata } from '@pierre/diffs';

/** Completely replaced large files have no matching lines: their exact patch is linear work. */
export function parseReviewFilePair({ oldFile, newFile }: DiffFileInput): FileDiffMetadata {
  if (oldFile && newFile && oldFile.contents.length + newFile.contents.length > 64 * 1024) {
    const lines = (content: string) => {
      const result = content.split('\n');
      if (content.endsWith('\n') || !content) result.pop();
      return result;
    };
    const oldLines = lines(oldFile.contents);
    const newLines = lines(newFile.contents);
    const oldSet = new Set(oldLines);
    if (oldLines.length && newLines.length && !newLines.some((line) => oldSet.has(line))) {
      const patchLines = (rows: string[], content: string, sign: string) =>
        rows
          .map(
            (line, index) =>
              `${sign}${line}\n${index === rows.length - 1 && !content.endsWith('\n') ? '\\ No newline at end of file\n' : ''}`,
          )
          .join('');
      const patch = `--- old\n+++ new\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${patchLines(oldLines, oldFile.contents, '-')}${patchLines(newLines, newFile.contents, '+')}`;
      const diff = processFile(patch, { oldFile, newFile, throwOnError: true });
      if (!diff) throw new Error('Unable to parse replaced file.');
      diff.name = newFile.name;
      diff.prevName = oldFile.name === newFile.name ? undefined : oldFile.name;
      diff.lang = newFile.lang;
      diff.cacheKey =
        oldFile.cacheKey && newFile.cacheKey
          ? JSON.stringify(['replacement', oldFile.cacheKey, newFile.cacheKey])
          : undefined;
      return diff;
    }
  }
  return parseDiffFromFile(oldFile, newFile);
}
