import * as stylex from '@stylexjs/stylex';
import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { parseReleaseNotes } from '../../../shared/release-notes';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';

const styles = stylex.create({
  content: {
    maxHeight: 'min(300px, 40dvh)',
    overflowY: 'auto',
    overflowWrap: 'anywhere',
    paddingTop: '0',
    paddingRight: '7px',
    paddingBottom: '0',
    paddingLeft: '0',
    scrollbarGutter: 'stable',
    fontSize: typeScale.compact,
    lineHeight: 1.65,
    color: colors.textMuted,
    outline: { default: 'none', ':focus-visible': `1px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': -1 },
  },
  paragraph: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: spacing.xl,
    marginLeft: '0',
  },
  lastBlock: { marginBottom: 0 },
  strong: { color: colors.textPrimary, fontWeight: 600 },
  list: {
    listStyle: 'none',
    marginTop: '0',
    marginRight: '0',
    marginBottom: '18px',
    marginLeft: '0',
    padding: 0,
  },
  laterItem: { marginTop: 3 },
  itemHeading: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBlock: spacing.md,
    paddingInline: '7px',
    borderRadius: radii.md,
    color: colors.textPrimary,
  },
  summary: {
    listStyle: 'none',
    cursor: 'pointer',
    fontWeight: 600,
    backgroundColor: { default: 'transparent', ':hover': colors.translucentHover },
    outline: { default: 'none', ':focus-visible': `1px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': -1 },
  },
  chevron: {
    flexShrink: 0,
    marginTop: 3,
    color: colors.textMuted,
    transform: { default: 'none', [stylex.when.ancestor('[open]')]: 'rotate(90deg)' },
  },
  bullet: { width: 13, flexShrink: 0, textAlign: 'center', color: colors.textMuted },
  description: {
    marginTop: '1px',
    marginRight: '7px',
    marginBottom: '10px',
    marginLeft: '28px',
  },
  descriptionParagraph: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '9px',
    marginLeft: '0',
  },
});

function InlineText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={index} {...stylex.props(styles.strong)}>
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function ReleaseNotes({ text }: { text: string }) {
  const blocks = useMemo(() => parseReleaseNotes(text), [text]);
  return (
    <div
      className={`release-notes-content ${stylex.props(styles.content).className}`}
      tabIndex={0}
      aria-label="Release notes"
    >
      {blocks.map((block, index) =>
        block.kind === 'paragraph' ? (
          <p key={index} {...stylex.props(styles.paragraph, index === blocks.length - 1 && styles.lastBlock)}>
            <InlineText text={block.text} />
          </p>
        ) : (
          <ul
            key={index}
            className={`release-notes-list ${stylex.props(styles.list, index === blocks.length - 1 && styles.lastBlock).className}`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={`${itemIndex}:${item.title}`} {...stylex.props(itemIndex > 0 && styles.laterItem)}>
                {item.paragraphs.length ? (
                  <details className={`release-note ${stylex.props(stylex.defaultMarker()).className}`}>
                    <summary {...stylex.props(styles.itemHeading, styles.summary)}>
                      <ChevronRight
                        size={13}
                        aria-hidden="true"
                        className={stylex.props(styles.chevron).className}
                      />
                      <span>
                        <InlineText text={item.title} />
                      </span>
                    </summary>
                    <div className={`release-note-description ${stylex.props(styles.description).className}`}>
                      {item.paragraphs.map((paragraph, paragraphIndex) => (
                        <p
                          key={paragraphIndex}
                          {...stylex.props(
                            styles.descriptionParagraph,
                            paragraphIndex === item.paragraphs.length - 1 && styles.lastBlock,
                          )}
                        >
                          <InlineText text={paragraph} />
                        </p>
                      ))}
                    </div>
                  </details>
                ) : (
                  <div className={`release-note-simple ${stylex.props(styles.itemHeading).className}`}>
                    <span
                      className={`release-note-bullet ${stylex.props(styles.bullet).className}`}
                      aria-hidden="true"
                    >
                      •
                    </span>
                    <span>
                      <InlineText text={item.title} />
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
