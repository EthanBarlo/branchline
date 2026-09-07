import { parseDiffFromFile } from '@pierre/diffs';
import type { ChangeContent } from '@pierre/diffs';
import type { DiffSide, ReviewFile } from '../../shared/types';
import type { CommentAnchor } from './commentAutosave';

type PlacementFile = Pick<ReviewFile, 'fingerprint' | 'oldContent' | 'newContent' | 'binary' | 'tooLarge'>;
export interface CommentPlacement { side: DiffSide; lineStart: number; lineEnd: number }
export interface PlacementSnapshot {
  file: PlacementFile;
  positions: Map<string, CommentPlacement | null>;
}

const normalize = (content: string) => content.replace(/\r\n/g, '\n');
export function contentLines(content: string | null): string[] {
  if (!content) return [];
  const lines = normalize(content).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
const sideContent = (file: PlacementFile, side: DiffSide) => side === 'deletions' ? file.oldContent : file.newContent;
const clamp = (line: number, length: number) => Math.max(1, Math.min(line, length));

export function captureCommentContext(content: string, lineStart: number, lineEnd: number) {
  const lines = contentLines(content);
  const before = lines.slice(Math.max(0, lineStart - 4), lineStart - 1);
  const after = lines.slice(lineEnd, lineEnd + 3);
  while (before.join('\n').length > 20000) before.shift();
  while (after.join('\n').length > 20000) after.pop();
  return {
    context: lines.slice(lineStart - 1, lineEnd).join('\n'),
    contextBefore: before.join('\n'),
    contextAfter: after.join('\n'),
  };
}

/** Match a saved excerpt without changing the line reference that will be exported. */
function findSavedRange(anchor: CommentAnchor, lines: string[]): { lineStart: number; lineEnd: number } {
  const selected = normalize(anchor.context).split('\n');
  const before = anchor.contextBefore ? normalize(anchor.contextBefore).split('\n') : [];
  const after = anchor.contextAfter ? normalize(anchor.contextAfter).split('\n') : [];
  const length = Math.max(1, anchor.lineEnd - anchor.lineStart + 1);
  const candidates = new Map<string, { start: number; end: number }>();
  const add = (start: number, end = start + length - 1) => {
    const boundedStart = clamp(start + 1, lines.length) - 1;
    const boundedEnd = Math.max(boundedStart, clamp(end + 1, lines.length) - 1);
    candidates.set(`${boundedStart}:${boundedEnd}`, { start: boundedStart, end: boundedEnd });
  };
  add(anchor.lineStart - 1);
  const matches = (needle: string[]) => {
    if (!needle.length || !needle.some(line => line.trim())) return [];
    // Linear sequence search keeps large, repetitive selections responsive.
    const prefix = new Array<number>(needle.length).fill(0);
    for (let index = 1, matched = 0; index < needle.length; index++) {
      while (matched > 0 && needle[index] !== needle[matched]) matched = prefix[matched - 1];
      if (needle[index] === needle[matched]) matched++;
      prefix[index] = matched;
    }
    const found: number[] = [];
    for (let index = 0, matched = 0; index < lines.length; index++) {
      while (matched > 0 && lines[index] !== needle[matched]) matched = prefix[matched - 1];
      if (lines[index] === needle[matched]) matched++;
      if (matched === needle.length) { found.push(index - needle.length + 1); matched = prefix[matched - 1]; }
    }
    return found;
  };
  for (const index of matches(selected)) add(index, index + selected.length - 1);
  const beforeEnds = matches(before).map(index => index + before.length);
  const afterStarts = matches(after);
  for (const start of beforeEnds) add(start);
  for (const end of afterStarts) add(end - length, end - 1);
  // Bracketing survives replacing a selection with a different number of lines,
  // or removing it entirely. Avoid a quadratic scan over repeated surroundings.
  let afterIndex = 0;
  for (const start of beforeEnds) {
    while (afterIndex < afterStarts.length && afterStarts[afterIndex] < start) afterIndex++;
    const end = afterStarts[afterIndex];
    if (end !== undefined) add(start, Math.max(start, end - 1));
  }
  // Legacy comments contain only the selection; a surviving line still gives
  // useful placement when another line in that selection has been edited.
  const sampledSelection = selected.map((line, offset) => ({ line, offset })).filter(({ line }) => line.trim()).slice(0, 20);
  const informative = sampledSelection.filter(({ line }) => line.trim().length > 1);
  for (const { line, offset } of informative) {
    for (let index = 0; index < lines.length; index++) if (lines[index] === line) add(index - offset);
  }
  const weight = (line: string) => line.trim() ? 4 : 0.25;
  const score = ({ start, end }: { start: number; end: number }) => {
    let value = 0;
    sampledSelection.forEach(({ line, offset }) => { if (start + offset <= end && lines[start + offset] === line) value += weight(line); });
    before.forEach((line, offset) => { if (lines[start - before.length + offset] === line) value += weight(line) * 2; });
    after.forEach((line, offset) => { if (lines[end + 1 + offset] === line) value += weight(line) * 2; });
    return value;
  };
  const ordered = [...candidates.values()].map(candidate => ({ ...candidate, score: score(candidate) })).sort((left, right) => right.score - left.score
    || Math.abs(left.start + 1 - anchor.lineStart) - Math.abs(right.start + 1 - anchor.lineStart));
  const best = ordered[0];
  return { lineStart: best.start + 1, lineEnd: best.end + 1 };
}

/** A mapper is shared by every comment moving between these two file sides. */
function makeLineMapper(oldContent: string, newContent: string): (line: number) => number {
  const newLength = contentLines(newContent).length;
  if (oldContent === newContent) return line => clamp(line, newLength);
  // Keep normal hunk context: zero-context pure insert/delete hunks use Git's
  // boundary coordinates rather than the zero-based line indexes we map here.
  const diff = parseDiffFromFile({ name: 'comment.txt', contents: oldContent }, { name: 'comment.txt', contents: newContent });
  const changes = diff.hunks.flatMap(hunk => hunk.hunkContent.filter((block): block is ChangeContent => block.type === 'change'));
  return line => {
    const index = line - 1;
    let offset = 0;
    for (const change of changes) {
      if (index < change.deletionLineIndex) break;
      if (index < change.deletionLineIndex + change.deletions) {
        // A replacement follows its corresponding line; a deletion stays by
        // the next surviving line (or the last line at the end of the file).
        return clamp(change.additionLineIndex + Math.min(index - change.deletionLineIndex, Math.max(0, change.additions - 1)) + 1, newLength);
      }
      offset = change.additionLineIndex + change.additions - change.deletionLineIndex - change.deletions;
    }
    return clamp(line + offset, newLength);
  };
}

/** Display-only relocation. Saved anchors and autosave sessions remain intact. */
export function placeComments(comments: ReadonlyArray<{ id: string; anchor: CommentAnchor }>, file: PlacementFile, previous?: PlacementSnapshot): PlacementSnapshot {
  const positions = new Map<string, CommentPlacement | null>();
  const lines = { additions: contentLines(file.newContent), deletions: contentLines(file.oldContent) };
  const mappers = new Map<string, (line: number) => number>();
  for (const { id, anchor } of comments) {
    if (anchor.lineStart === 0 || file.binary || file.tooLarge || !(lines.additions.length || lines.deletions.length)) {
      positions.set(id, null);
      continue;
    }
    const side = lines[anchor.side].length ? anchor.side : anchor.side === 'additions' ? 'deletions' : 'additions';
    const target = lines[side];
    if (anchor.fingerprint === file.fingerprint) {
      positions.set(id, { side, lineStart: clamp(anchor.lineStart, target.length), lineEnd: clamp(anchor.lineEnd, target.length) });
      continue;
    }
    const prior = previous?.positions.get(id);
    if (prior && previous) {
      if (previous.file.fingerprint === file.fingerprint) {
        positions.set(id, prior);
        continue;
      }
      const oldContent = sideContent(previous.file, prior.side);
      const newContent = sideContent(file, side);
      if (oldContent !== null && newContent !== null) {
        const key = `${prior.side}:${side}`;
        try {
          let map = mappers.get(key);
          if (!map) { map = makeLineMapper(oldContent, newContent); mappers.set(key, map); }
          const lineStart = map(prior.lineStart);
          positions.set(id, { side, lineStart, lineEnd: Math.max(lineStart, map(prior.lineEnd)) });
          continue;
        } catch { /* Context matching still provides an anchor if parsing fails. */ }
      }
    }
    positions.set(id, { side, ...findSavedRange(anchor, target) });
  }
  return { file: { fingerprint: file.fingerprint, oldContent: file.oldContent, newContent: file.newContent, binary: file.binary, tooLarge: file.tooLarge }, positions };
}
