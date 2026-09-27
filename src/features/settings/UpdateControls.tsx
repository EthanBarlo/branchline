import * as stylex from '@stylexjs/stylex';
import { ArrowDownToLine, Check, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react';
import type { UpdateState } from '../../../shared/updates';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { ReleaseNotes } from './ReleaseNotes';

const styles = stylex.create({
  button: {
    display: 'inline-flex',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 25,
    marginBlock: '0',
    marginInline: spacing.sm,
    paddingBlock: '0',
    paddingInline: spacing.md,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radii.md,
    backgroundColor: { default: 'transparent', ':hover': colors.interactive },
    color: { default: colors.textMuted, ':hover': colors.textPrimary },
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    WebkitAppRegion: 'no-drag',
  },
  readyButton: { borderColor: colors.borderStrong, backgroundColor: colors.raised, color: colors.accent },
  details: {
    paddingTop: '0',
    paddingRight: '22px',
    paddingBottom: '22px',
    paddingLeft: '22px',
  },
  embeddedDetails: {
    paddingTop: '14px',
    paddingRight: '25px',
    paddingBottom: '25px',
    paddingLeft: '25px',
  },
  embeddedFooter: {
    paddingBlock: spacing.xl,
    paddingInline: '25px',
  },
  version: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingTop: '11px',
    paddingRight: '0',
    paddingBottom: '20px',
    paddingLeft: '0',
    color: colors.textMuted,
  },
  versionLabel: { fontSize: typeScale.caption, letterSpacing: 1 },
  versionCode: { fontFamily: fonts.code, fontSize: typeScale.compact, color: colors.textPrimary },
  status: { display: 'flex', alignItems: 'flex-start', gap: 13 },
  statusIcon: {
    display: 'grid',
    placeItems: 'center',
    width: 42,
    height: 42,
    flexShrink: 0,
    backgroundColor: colors.raised,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: 9,
    color: colors.textSecondary,
  },
  statusHeading: {
    marginTop: '1px',
    marginRight: '0',
    marginBottom: '7px',
    marginLeft: '0',
    fontSize: 14,
    fontWeight: 550,
    letterSpacing: '-.2px',
  },
  statusText: { margin: 0, color: colors.textMuted, fontSize: typeScale.compact, lineHeight: 1.7 },
  download: { display: 'flex', alignItems: 'center', gap: spacing.lg, marginTop: 22 },
  progressTrack: {
    width: '100%',
    height: 4,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.hover,
  },
  progressFill: (value: number) => ({
    display: 'block',
    width: `${value}%`,
    height: '100%',
    backgroundColor: colors.accent,
    transition: { default: 'width .15s', '@media (prefers-reduced-motion: reduce)': 'none' },
  }),
  progressLabel: {
    minWidth: 32,
    color: colors.textSecondary,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    textAlign: 'right',
  },
  notes: {
    marginTop: spacing.xxl,
    paddingTop: spacing.xl,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  notesHeading: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '10px',
    marginLeft: '0',
    fontSize: typeScale.compact,
    fontWeight: 550,
  },
  error: {
    display: 'flex',
    gap: 9,
    marginTop: 20,
    padding: spacing.lg,
    backgroundColor: colors.warningSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: 5,
    color: colors.warningStrong,
    fontSize: typeScale.compact,
    lineHeight: 1.6,
  },
  errorIcon: { flexShrink: 0, marginTop: spacing.xxs },
  'modal-footer': {
    paddingBlock: '17px',
    paddingInline: '27px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderStrong,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '9px',
    backgroundColor: colors.surface,
  },
});

export function UpdateButton({ state, onClick }: { state: UpdateState | null; onClick: () => void }) {
  const busy = state?.phase === 'checking' || state?.phase === 'downloading';
  const ready = state?.phase === 'downloaded';
  const available = state?.phase === 'available';
  const label = ready
    ? 'Restart to update'
    : available
      ? 'Update available'
      : state?.phase === 'downloading'
        ? `Downloading ${Math.round(state.progress || 0)}%`
        : 'Updates';
  return (
    <button
      {...stylex.props(styles.button, (ready || available) && styles.readyButton)}
      onClick={onClick}
      aria-label={label}
      title="Branchline updates"
    >
      {busy ? <Spinner size={12} /> : ready ? <RotateCw size={12} /> : <ArrowDownToLine size={12} />}
      <span>{label}</span>
    </button>
  );
}

export function UpdateDetails({
  state,
  bridgeError,
  onAction,
  onClose,
  embedded = false,
}: {
  state: UpdateState | null;
  bridgeError: string | null;
  onAction: (action: 'check' | 'download' | 'install') => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  if (!state) {
    const detailsStyle = stylex.props(styles.details, embedded && styles.embeddedDetails);
    return (
      <div {...detailsStyle} className={`update-details ${detailsStyle.className}`}>
        <p role="status">{bridgeError || 'Connecting to Branchline…'}</p>
      </div>
    );
  }
  const phase = state.phase;
  const error = bridgeError || state.error?.message;
  const title =
    phase === 'disabled'
      ? 'Updates in the desktop app'
      : phase === 'checking'
        ? 'Checking for updates…'
        : phase === 'available'
          ? `Branchline ${state.availableVersion} is available`
          : phase === 'downloading'
            ? 'Downloading your update…'
            : phase === 'downloaded'
              ? 'Ready when you are'
              : state.lastCheckedAt && !error
                ? 'You’re up to date'
                : 'Keep Branchline up to date';
  const detailsStyle = stylex.props(styles.details, embedded && styles.embeddedDetails);
  const footerStyle = stylex.props(embedded && styles.embeddedFooter);
  return (
    <>
      <div {...detailsStyle} className={`update-details ${detailsStyle.className}`}>
        <div {...stylex.props(styles.version)}>
          <span {...stylex.props(styles.versionLabel)}>INSTALLED VERSION</span>
          <code {...stylex.props(styles.versionCode)}>{state.currentVersion}</code>
        </div>
        <div {...stylex.props(styles.status)} role="status" aria-live="polite">
          <span {...stylex.props(styles.statusIcon)}>
            {phase === 'downloading' || phase === 'checking' ? (
              <Spinner size={22} />
            ) : phase === 'downloaded' ? (
              <RotateCw size={22} />
            ) : phase === 'idle' && state.lastCheckedAt && !error ? (
              <Check size={22} />
            ) : (
              <ArrowDownToLine size={22} />
            )}
          </span>
          <div>
            <h3 {...stylex.props(styles.statusHeading)}>{title}</h3>
            <p {...stylex.props(styles.statusText)}>
              {phase === 'disabled'
                ? state.disabledReason
                : phase === 'downloaded'
                  ? 'Restart to install. Your review work will be saved first. macOS may ask for an administrator password.'
                  : phase === 'downloading'
                    ? 'You can keep reviewing while the download finishes.'
                    : 'Updates are checked automatically. You choose when to download and restart.'}
            </p>
          </div>
        </div>
        {phase === 'downloading' && (
          <div {...stylex.props(styles.download)}>
            <div
              {...stylex.props(styles.progressTrack)}
              role="progressbar"
              aria-label="Update download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.progress || 0}
            >
              <span {...stylex.props(styles.progressFill(state.progress || 0))} />
            </div>
            <span {...stylex.props(styles.progressLabel)}>{Math.round(state.progress || 0)}%</span>
          </div>
        )}
        {error && (
          <div {...stylex.props(styles.error)} role="alert">
            <TriangleAlert size={16} {...stylex.props(styles.errorIcon)} />
            <span>{error}</span>
          </div>
        )}
        {state.availableVersion && state.releaseNotes && (
          <section {...stylex.props(styles.notes)}>
            <h4 {...stylex.props(styles.notesHeading)}>What’s new in {state.availableVersion}</h4>
            <ReleaseNotes key={state.availableVersion} text={state.releaseNotes} />
          </section>
        )}
      </div>
      <div
        {...footerStyle}
        className={`${`modal-footer ${stylex.props(styles['modal-footer']).className}`} ${footerStyle.className}`}
      >
        <Button onClick={onClose}>
          {phase === 'available' || phase === 'downloaded' ? 'Later' : 'Close'}
        </Button>
        {phase === 'downloaded' && error && (
          <Button onClick={() => onAction('download')}>Download again</Button>
        )}
        {phase === 'idle' && (
          <Button variant="primary" onClick={() => onAction('check')}>
            <RefreshCw size={14} />
            {error ? 'Retry check' : 'Check for updates'}
          </Button>
        )}
        {phase === 'available' && (
          <Button variant="primary" onClick={() => onAction('download')}>
            <ArrowDownToLine size={14} />
            {state.error?.action === 'download' ? 'Retry download' : 'Download update'}
          </Button>
        )}
        {phase === 'downloaded' && (
          <Button variant="primary" onClick={() => onAction('install')}>
            <RotateCw size={14} />
            {error ? 'Retry update' : 'Restart to update'}
          </Button>
        )}
      </div>
    </>
  );
}
