import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileTree } from '@pierre/trees';
import { orderReviewFiles, reviewFilePath } from '../src/components/reviewFileOrder';
import type { ReviewFile } from '../shared/types';

function file(path: string, repoRelativePath = '.'): ReviewFile {
  return { id: `${repoRelativePath}/${path}`, repoRelativePath, path, status: 'M', additions: 1, deletions: 1, oldContent: 'before', newContent: 'after', binary: false, fingerprint: path, baseCommit: 'base', headCommit: 'head', source: 'committed' };
}

test('review progression follows folders before root files and natural numeric names', () => {
  const files = [file('a-root.ts'), file('zeta/part10.ts'), file('zeta/part2.ts'), file('zeta/part1.ts')];
  const ordered = orderReviewFiles(files);
  assert.deepEqual(ordered.map(reviewFilePath), ['zeta/part1.ts', 'zeta/part2.ts', 'zeta/part10.ts', 'a-root.ts']);
  assert.equal(ordered[0], files[3], 'retain snapshot objects and fingerprints');
  assert.equal(files[0].path, 'a-root.ts', 'do not reorder the source snapshot');
});

test('canonical fallback matches expanded explorer projection across submodules and collapsed directories', () => {
  const files = [file('README.md'), file('src/file10.ts', 'packages/api'), file('src/file2.ts', 'packages/api'), file('lib/utils/index.ts'), file('lib/a.ts')];
  const paths = files.map(reviewFilePath);
  const tree = new FileTree({ paths, flattenEmptyDirectories: true, initialExpansion: 'open' });
  const visiblePaths = () => tree.getVisibleRows(0, tree.getVisibleCount() - 1).filter(row => row.kind === 'file').map(row => row.path);
  try {
    assert.deepEqual(orderReviewFiles(files).map(reviewFilePath), visiblePaths());
    const lib = tree.getItem('lib/');
    if (lib && 'collapse' in lib) lib.collapse();
    assert.deepEqual(visiblePaths(), ['packages/api/src/file2.ts', 'packages/api/src/file10.ts', 'README.md']);
    assert.equal(orderReviewFiles(files).length, files.length, 'fallback still includes files under collapsed folders');
  } finally { tree.cleanUp(); }
});
