import * as stylex from '@stylexjs/stylex';
import { GitBranch, GitCompareArrows } from 'lucide-react';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';

const styles = stylex.create({
  'current-setup': {
    display: 'flex',
    flex: '1',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '30px',
    overflow: 'auto',
  },
  'current-setup-content': {
    maxWidth: '100%',
    width: '420px',
    paddingBottom: '35px',
    textAlign: 'center',
  },
  currentSetupIcon: { width: 27, height: 27, color: colors.textMuted, marginBottom: spacing.md },
  currentSetupTitle: {
    marginTop: '13px',
    marginRight: '0',
    marginBottom: '10px',
    marginLeft: '0',
    color: colors.textDefault,
    fontSize: 22,
    lineHeight: 1.35,
    fontWeight: 450,
    letterSpacing: '-.5px',
  },
  currentSetupDescription: {
    maxWidth: 365,
    marginTop: '0',
    marginRight: 'auto',
    marginBottom: '17px',
    marginLeft: 'auto',
    color: colors.textMuted,
    fontSize: typeScale.body,
    lineHeight: 1.8,
  },
});

export function CurrentSetup({
  detached,
  onReviewBranch,
}: {
  detached: boolean;
  onReviewBranch: () => void;
}) {
  return (
    <div className={`current-setup ${stylex.props(styles['current-setup']).className}`}>
      <div className={`current-setup-content ${stylex.props(styles['current-setup-content']).className}`}>
        <GitCompareArrows
          size={24}
          strokeWidth={1.4}
          className={stylex.props(styles.currentSetupIcon).className}
        />
        <h2 {...stylex.props(styles.currentSetupTitle)}>
          {detached ? 'Check out a branch to continue.' : 'Choose a target branch.'}
        </h2>
        <p {...stylex.props(styles.currentSetupDescription)}>
          {detached
            ? 'Current will resume automatically when you check out a branch.'
            : 'Select a target in the toolbar above. It will stay selected as you work.'}
        </p>
        {detached && (
          <Button onClick={onReviewBranch}>
            <GitBranch size={14} />
            Review another branch
          </Button>
        )}
      </div>
    </div>
  );
}
