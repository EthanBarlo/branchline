import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiffFromFile, type FileContents } from '@pierre/diffs';
import { parseReviewFilePair } from '../src/features/reviews/diff/diffParsing';

const comparable = (diff: ReturnType<typeof parseDiffFromFile>) => {
  const { cacheKey, ...value } = diff;
  return value;
};

test('the linear replacement path preserves the exact diff, rename, line endings and EOF markers', () => {
  for (const ending of ['\n', '\r\n', '']) {
    const oldFile: FileContents = {
      name: 'before.ts',
      cacheKey: 'old',
      contents: Array.from({ length: 1500 }, (_, index) => `old${index} = 'before';`).join('\n') + ending,
    };
    const newFile: FileContents = {
      name: 'after.ts',
      cacheKey: 'new',
      contents: Array.from({ length: 1500 }, (_, index) => `new${index} = 'after';`).join('\n') + ending,
    };
    assert.deepEqual(
      comparable(parseReviewFilePair({ oldFile, newFile })),
      comparable(parseDiffFromFile(oldFile, newFile)),
    );
  }
});

test('partly matching files and additions/deletions retain normal hunk and context behavior', () => {
  const oldFile = {
    name: 'file.ts',
    cacheKey: 'old',
    contents: Array.from({ length: 3000 }, (_, index) => `export const line${index} = 0;`).join('\n') + '\n',
  };
  const newFile = {
    ...oldFile,
    cacheKey: 'new',
    contents: oldFile.contents.replace('line1500 = 0', 'line1500 = 1'),
  };
  for (const pair of [
    { oldFile, newFile },
    { oldFile: null, newFile },
    { oldFile, newFile: null },
  ]) {
    assert.deepEqual(
      comparable(parseReviewFilePair(pair)),
      comparable(parseDiffFromFile(pair.oldFile, pair.newFile)),
    );
  }
});
