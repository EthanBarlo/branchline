import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { parseReleaseNotes } from '../../shared/release-notes';

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</>;
}

export function ReleaseNotes({ text }: { text: string }) {
  const blocks = useMemo(() => parseReleaseNotes(text), [text]);
  return <div className="release-notes-content" tabIndex={0} aria-label="Release notes">
    {blocks.map((block, index) => block.kind === 'paragraph'
      ? <p key={index}><InlineText text={block.text} /></p>
      : <ul className="release-notes-list" key={index}>{block.items.map((item, itemIndex) => <li key={`${itemIndex}:${item.title}`}>
        {item.paragraphs.length ? <details className="release-note">
          <summary><ChevronRight size={13} aria-hidden="true" /><span><InlineText text={item.title} /></span></summary>
          <div className="release-note-description">{item.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}><InlineText text={paragraph} /></p>)}</div>
        </details> : <div className="release-note-simple"><span className="release-note-bullet" aria-hidden="true">•</span><span><InlineText text={item.title} /></span></div>}
      </li>)}</ul>)}
  </div>;
}
