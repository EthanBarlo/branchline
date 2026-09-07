import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommentAnchor } from '../src/components/commentAutosave';
import { CommentAutosave } from '../src/components/commentAutosave';
import { captureCommentContext, placeComments } from '../src/components/commentPlacement';

const file = (newContent: string | null, fingerprint: string, oldContent: string | null = 'original\n') => ({ newContent, oldContent, fingerprint, binary: false });
const anchor = (content: string, lineStart: number, lineEnd = lineStart, side: 'additions' | 'deletions' = 'additions'): CommentAnchor => ({
  side, lineStart, lineEnd, fingerprint: 'first', path: 'src/review.ts', ...captureCommentContext(content, lineStart, lineEnd),
});

test('insertions before multiple comments shift display positions without changing their saved anchors', () => {
  const contents = 'function example() {\n  first();\n  second();\n}\n';
  const comments = [
    { id: 'first', anchor: Object.freeze(anchor(contents, 2)) },
    { id: 'second', anchor: Object.freeze(anchor(contents, 3, 4)) },
  ];
  const original = structuredClone(comments);
  const initial = placeComments(comments, file(contents, 'first'));
  const updated = placeComments(comments, file(`// inserted\n\n${contents}`, 'second'), initial);
  assert.deepEqual(updated.positions.get('first'), { side: 'additions', lineStart: 4, lineEnd: 4 });
  assert.deepEqual(updated.positions.get('second'), { side: 'additions', lineStart: 5, lineEnd: 6 });
  assert.deepEqual(comments, original);
});

test('successive refreshes track replacement and deleted lines next to surviving code', () => {
  const contents = 'start\nremove this\nchange this\nend\n';
  const comments = [{ id: 'deleted', anchor: anchor(contents, 2) }, { id: 'edited', anchor: anchor(contents, 3) }];
  const initial = placeComments(comments, file(contents, 'first'));
  const replacement = placeComments(comments, file('start\nremove this\nreplacement\nend\n', 'second'), initial);
  assert.equal(replacement.positions.get('edited')?.lineEnd, 3);
  const deletion = placeComments(comments, file('start\nreplacement\nend\n', 'third'), replacement);
  assert.equal(deletion.positions.get('deleted')?.lineEnd, 2);
  assert.equal(deletion.positions.get('edited')?.lineEnd, 2);
  assert.equal(deletion.positions.size, 2, 'Two comments may share one nearby line without losing either comment.');
});

test('deletion-side anchors follow changes to the original side independently', () => {
  const oldContent = 'before\nremoved code\nafter\n';
  const comments = [{ id: 'left', anchor: anchor(oldContent, 2, 2, 'deletions') }];
  const initial = placeComments(comments, file('different feature\n', 'first', oldContent));
  const changed = placeComments(comments, file('unrelated feature changes\n', 'second', `new base line\n${oldContent}`), initial);
  assert.deepEqual(changed.positions.get('left'), { side: 'deletions', lineStart: 3, lineEnd: 3 });
});

test('restart placement finds unchanged selected code and disambiguates repeated snippets with surrounding context', () => {
  const original = 'first function\nrepeat();\nfirst end\nsecond function\nrepeat();\nsecond end\n';
  const comment = { id: 'repeat', anchor: anchor(original, 5) };
  const current = 'inserted\ninserted again\n' + original;
  const result = placeComments([comment], file(current, 'reopened'));
  assert.equal(result.positions.get('repeat')?.lineEnd, 7);
  assert.equal(comment.anchor.lineEnd, 5);
});

test('restart placement brackets edited selections even when their line count changes', () => {
  const original = 'before one\nbefore two\nbefore three\nold value\nafter one\nafter two\nafter three\n';
  const comment = { id: 'edited', anchor: anchor(original, 4) };
  const current = 'inserted\nbefore one\nbefore two\nbefore three\nnew value\nextra validation\nafter one\nafter two\nafter three\n';
  const result = placeComments([comment], file(current, 'reopened'));
  assert.deepEqual(result.positions.get('edited'), { side: 'additions', lineStart: 5, lineEnd: 6 });
});

test('restart placement keeps deleted selections near their surviving surroundings', () => {
  const original = 'before one\nbefore two\nbefore three\nremoved\nafter one\nafter two\nafter three\n';
  const comment = { id: 'deleted', anchor: anchor(original, 4) };
  const current = 'inserted\nbefore one\nbefore two\nbefore three\nafter one\nafter two\nafter three\n';
  const result = placeComments([comment], file(current, 'reopened'));
  assert.ok([4, 5].includes(result.positions.get('deleted')!.lineEnd));
});

test('legacy comments recover from selected code alone and otherwise clamp safely', () => {
  const comments = [
    { id: 'legacy', anchor: { side: 'additions' as const, lineStart: 2, lineEnd: 2, context: 'selected();', fingerprint: 'old' } },
    { id: 'missing', anchor: { side: 'additions' as const, lineStart: 99, lineEnd: 100, context: 'gone', fingerprint: 'old' } },
    { id: 'brace', anchor: { side: 'additions' as const, lineStart: 1, lineEnd: 1, context: '}', fingerprint: 'old' } },
  ];
  const result = placeComments(comments, file('new\nnew again\nold\nselected();\n}\n', 'reopened'));
  assert.equal(result.positions.get('legacy')?.lineEnd, 4);
  assert.deepEqual(result.positions.get('missing'), { side: 'additions', lineStart: 5, lineEnd: 5 });
  assert.equal(result.positions.get('brace')?.lineEnd, 5);
});

test('a removed side uses surviving code while file-level, empty and binary comments stay at the top', () => {
  const comment = { id: 'side', anchor: anchor('before\nselected\nafter\n', 2) };
  const removedSide = placeComments([comment], file(null, 'removed', 'before\nselected\nafter\n'));
  assert.deepEqual(removedSide.positions.get('side'), { side: 'deletions', lineStart: 2, lineEnd: 2 });
  const level = { id: 'file', anchor: { ...comment.anchor, lineStart: 0, lineEnd: 0 } };
  assert.equal(placeComments([level], file('code\n', 'other')).positions.get('file'), null);
  assert.equal(placeComments([comment], file('', 'empty', null)).positions.get('side'), null);
  assert.equal(placeComments([comment], { ...file('code\n', 'binary'), binary: true }).positions.get('side'), null);
});

test('trailing newline and CRLF changes never produce an annotation past the rendered lines', () => {
  const original = 'first\r\nselected\r\n';
  const comments = [{ id: 'last', anchor: anchor(original, 2) }];
  const initial = placeComments(comments, file(original, 'first'));
  const result = placeComments(comments, file('first\n', 'second'), initial);
  assert.equal(result.positions.get('last')?.lineEnd, 1);
});

test('oversized neighboring lines do not make a short comment exceed the saved context limit', () => {
  const context = captureCommentContext(`${'x'.repeat(25000)}\nselected\nnearby\n${'y'.repeat(25000)}\n`, 2, 2);
  assert.equal(context.context, 'selected');
  assert.equal(context.contextBefore, '');
  assert.equal(context.contextAfter, 'nearby');
});

test('moving an annotation during its first save preserves its session, UUID and original code reference', async () => {
  const original = 'before\nselected\nafter\n';
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const saved: { id: string; anchor: CommentAnchor; body: string }[] = [];
  const session = new CommentAutosave({ id: 'stable-comment', scope: 'review', fileId: 'file', anchor: anchor(original, 2), callbacks: {
    add: async (reference, body, id) => { saved.push({ id, anchor: reference, body }); await pending; },
    update: async () => { throw new Error('A moving comment must not create a second write.'); },
    delete: async () => {}, removed: () => {},
  } });
  const unmount = session.mount();
  session.change('Keep this feedback.');
  const save = session.flush();
  const initial = placeComments([session], file(original, 'first'));
  const moved = placeComments([session], file(`inserted\n${original}`, 'second'), initial);
  unmount();
  const remounted = session.mount();
  finish();
  await save;
  await session.flush();
  assert.equal(moved.positions.get(session.id)?.lineEnd, 3);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, session.id);
  assert.equal(saved[0].anchor.lineEnd, 2);
  assert.equal(session.getSnapshot().body, 'Keep this feedback.');
  assert.equal(session.getSnapshot().persisted, true);
  remounted();
});
