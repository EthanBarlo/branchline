import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileTree } from '@pierre/trees';
import type { ReviewFile } from '../shared/types';
import { reviewFilePath } from "../src/features/reviews/reviewFileOrder";
import { selectedReviewFiles } from "../src/features/reviews/reviewTreeSelection";

function file(path: string, repoRelativePath = '.'): ReviewFile {
  return { id: `${repoRelativePath}/${path}`, repoRelativePath, path, status: 'M', additions: 1, deletions: 1, oldContent: 'before', newContent: 'after', binary: false, fingerprint: `version:${path}`, baseCommit: 'base', headCommit: 'head', source: 'committed' };
}

function snapshot(files: ReviewFile[]) {
  return new Map(files.map(file => [reviewFilePath(file), file]));
}

test('folder actions include collapsed descendants and retain exact snapshot versions', () => {
  const nested = file('src/nested/deep/file.ts');
  const direct = file('src/direct.ts');
  const unavailable = { ...file('src/unavailable.ts'), unavailable: 'Download failed.' };
  const byPath = snapshot([nested, direct, unavailable, file('src-other/file.ts'), file('root.ts')]);
  const tree = new FileTree({ paths: [...byPath.keys()], initialExpansion: 'closed', flattenEmptyDirectories: true });
  try {
    const folder = tree.getItem('src/');
    assert.ok(folder && 'collapse' in folder);
    folder.select();
    assert.equal(tree.getVisibleRows(0, tree.getVisibleCount() - 1).some(row => row.path === 'src/nested/deep/file.ts'), false);
    const selected = selectedReviewFiles(tree.getSelectedPaths(), byPath);
    assert.deepEqual(selected, [nested, direct, unavailable]);
    assert.equal(selected[0], nested, 'Retain the exact reviewed content fingerprint.');
    assert.equal(selected[2], unavailable, 'Do not silently exclude unavailable files from the existing approval safeguards.');
  } finally { tree.cleanUp(); }
});

test('folder actions respect the filtered snapshot and ignore missing paths', () => {
  const match = file('src/nested/match.ts');
  const other = file('src/other.ts');
  const filtered = snapshot([match]);
  assert.deepEqual(selectedReviewFiles(['src/', 'src/other.ts', 'missing/'], filtered), [match]);
  assert.deepEqual(selectedReviewFiles(['src'], snapshot([match, other])), [], 'Only a directory path can select descendants.');
  assert.deepEqual(selectedReviewFiles([], filtered), []);
});

test('mixed parent, nested-folder and file selections are deduplicated across repository paths', () => {
  const direct = file('src/direct.ts', 'packages/api');
  const nested = file('src/nested/file.ts', 'packages/api');
  const other = file('src/other.ts', 'packages/api-other');
  const root = file('root.ts');
  const byPath = snapshot([direct, nested, other, root]);
  assert.deepEqual(selectedReviewFiles(['packages/api/', 'packages/api/src/', 'packages/api/src/nested/file.ts', 'root.ts', 'packages/api/'], byPath), [direct, nested, root]);
});
