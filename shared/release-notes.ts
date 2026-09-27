export interface ReleaseNoteItem {
  title: string;
  paragraphs: string[];
}
export type ReleaseNoteBlock =
  { kind: 'paragraph'; text: string } | { kind: 'list'; items: ReleaseNoteItem[] };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    if (key.startsWith('#')) {
      const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '\ufffd';
    }
    return (
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[
        key.toLowerCase()
      ] ?? entity
    );
  });
}

function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/\s+/g, ' ')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/?(?:p|div|h[1-6]|ul|ol|blockquote|pre)\b[^>]*>/gi, '\n\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep list descriptions indented while transporting only text to the renderer. */
export function releaseNotesToText(notes: string): string {
  const bounded = notes
    .slice(0, 30_000)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/<(script|style|iframe|object)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '');
  if (!/<\/?[a-z][^>]*>/i.test(bounded)) return decodeEntities(bounded).trim();
  return bounded
    .split(/(<li\b[^>]*>[^]*?<\/li\s*>)/gi)
    .map((part) => {
      const item = /^<li\b[^>]*>([^]*)<\/li\s*>$/i.exec(part);
      if (!item) return htmlText(part);
      const [title, ...description] = htmlText(item[1]).split('\n');
      if (!title) return '';
      return [`• ${title}`, ...description.map((line) => (line ? `  ${line}` : ''))].join('\n').trimEnd();
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Indentation, not surrounding blank lines, determines which text belongs to a bullet. */
export function parseReleaseNotes(notes: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = [];
  let item: ReleaseNoteItem | undefined;
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(' ').trim();
    if (text) {
      if (item) item.paragraphs.push(text);
      else blocks.push({ kind: 'paragraph', text });
    }
    paragraph = [];
  };
  for (const line of notes.slice(0, 30_000).split(/\r?\n/)) {
    const bullet = /^\s*[-+*•]\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      const previous = blocks.at(-1);
      const list = previous?.kind === 'list' ? previous : { kind: 'list' as const, items: [] };
      if (list !== previous) blocks.push(list);
      item = { title: bullet[1].trim(), paragraphs: [] };
      list.items.push(item);
    } else if (!line.trim()) {
      flush();
    } else {
      if (item && !/^(?: {2,}|\t)/.test(line)) {
        flush();
        item = undefined;
      }
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}
