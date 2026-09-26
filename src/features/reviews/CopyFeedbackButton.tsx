import * as stylex from '@stylexjs/stylex';
import { CheckCheck, Clipboard } from 'lucide-react';
import { colors, radii, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';

interface CopyFeedbackButtonProps {
  state: 'idle' | 'copying' | 'copied';
  count: number;
  inToolbar?: boolean;
  onCopy: () => void;
}

export function CopyFeedbackButton({ state, count, inToolbar = false, onCopy }: CopyFeedbackButtonProps) {
  return (
    <Button
      variant="primary"
      copied={state === 'copied'}
      className={`copy-button ${stylex.props(inToolbar && styles.toolbar, !inToolbar && styles.panel).className}`}
      disabled={!count || state === 'copying'}
      onClick={onCopy}
      title="Copy unresolved comments grouped by file, with line references"
    >
      {state === 'copying' ? (
        <Spinner size={15} />
      ) : state === 'copied' ? (
        <CheckCheck size={16} />
      ) : (
        <Clipboard size={15} />
      )}
      <span>{state === 'copied' ? 'Copied feedback' : 'Copy feedback'}</span>
      {count > 0 && (
        <span
          className={`button-count ${stylex.props(styles.count, inToolbar && styles.toolbarCount).className}`}
        >
          {count}
        </span>
      )}
    </Button>
  );
}

const styles = stylex.create({
  toolbar: {
    minHeight: 27,
    height: 27,
    borderRadius: radii.md,
    paddingBlock: 0,
    paddingInline: { default: 9, '@media (max-width: 860px)': 7 },
    gap: spacing.sm,
    fontSize: typeScale.small,
  },
  panel: { width: '100%' },
  count: { color: colors.textInverse, fontSize: typeScale.micro, opacity: 0.75 },
  toolbarCount: { display: { default: 'inline', '@media (max-width: 860px)': 'none' } },
});
