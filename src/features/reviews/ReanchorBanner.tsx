import * as stylex from '@stylexjs/stylex';
import { colors, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';

export function ReanchorBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div className={`reanchor-banner ${stylex.props(styles['reanchor-banner']).className}`} role="status">
      <span {...stylex.props(styles.reanchorText)}>
        Select the current file and lines for your comment. Its text will be preserved.
      </span>
      <Button className={stylex.props(styles.reanchorButton).className} onClick={onCancel}>
        Cancel selection
      </Button>
    </div>
  );
}

const styles = stylex.create({
  'reanchor-banner': {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    paddingBlock: 9,
    paddingInline: 13,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
    color: colors.warningText,
    fontSize: typeScale.compact,
  },
  reanchorText: { flex: '1' },
  reanchorButton: { minHeight: 24, fontSize: typeScale.small },
});
