import * as stylex from '@stylexjs/stylex';
import type { UpdateState } from '../../../shared/updates';
import { colors, typeScale } from '../../theme/tokens.stylex';
import { Spinner } from '../../ui/Spinner';

export function WorkspaceLock({
  closingReview,
  updatePreparing,
  closePreparing,
  phase,
}: {
  closingReview: boolean;
  updatePreparing: boolean;
  closePreparing: boolean;
  phase?: UpdateState['phase'];
}) {
  if (!closingReview && !updatePreparing && !closePreparing) return null;
  const title = closePreparing
    ? 'Closing your workspace…'
    : updatePreparing
      ? phase === 'installing'
        ? 'Installing your update…'
        : 'Saving your workspace…'
      : 'Closing completed review…';
  const description = closePreparing
    ? 'Saving your comments and completing active operations.'
    : updatePreparing
      ? phase === 'installing'
        ? 'Your review work is saved. If macOS asks for an administrator password, use the system prompt to continue.'
        : 'Saving your comments and completing active operations before installing.'
      : 'Saving your feedback and confirming every repository is finished.';
  return (
    <div className={`update-lock ${stylex.props(styles.lock).className}`} role="status" aria-live="polite">
      <Spinner size={26} />
      <h2 {...stylex.props(styles.title)}>{title}</h2>
      <p {...stylex.props(styles.description)}>{description}</p>
    </div>
  );
}

const styles = stylex.create({
  lock: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
    color: colors.textPrimary,
  },
  title: { marginTop: 18, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 18, fontWeight: 550 },
  description: { color: colors.textMuted, fontSize: typeScale.body },
});
