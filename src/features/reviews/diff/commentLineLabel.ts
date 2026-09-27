import type { CommentAnchor } from './commentAutosave';
export function lineLabel(anchor: Pick<CommentAnchor, 'side' | 'lineStart' | 'lineEnd'>) {
  if (anchor.lineStart === 0) return 'file comment';
  return `line ${anchor.lineStart}${anchor.lineEnd === anchor.lineStart ? '' : `–${anchor.lineEnd}`}${anchor.side === 'deletions' ? ', original version' : ''}`;
}
