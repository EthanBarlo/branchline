import * as stylex from '@stylexjs/stylex';
import { Ticket, TriangleAlert, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { colors, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/Spinner';
import { JiraTicketSelect } from '../tickets/JiraTicketSelect';
import { useJiraBrowserSession } from './useJiraBrowserSession';
import { useJiraDialogFocus } from './useJiraDialogFocus';

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  backdrop: { padding: spacing.xxl, animationName: 'none' },
  modal: {
    display: 'flex',
    flexDirection: 'column',
    width: 'min(1600px, 100%)',
    height: 'calc(100dvh - 72px)',
    marginTop: 24,
    maxHeight: 'none',
    overflow: 'hidden',
    borderRadius: 7,
    outline: { default: 'none', ':focus': 'none' },
  },
  picker: {
    width: 520,
    height: 'auto',
    marginTop: 0,
    maxHeight: 'calc(100dvh - 48px)',
    overflow: 'visible',
    borderRadius: 11,
  },
  pickerFooter: {
    borderTopLeftRadius: '0',
    borderTopRightRadius: '0',
    borderBottomRightRadius: '11px',
    borderBottomLeftRadius: '11px',
  },
  pickerEyebrow: { fontSize: typeScale.micro, color: colors.textSubtle, letterSpacing: '1.7px' },
  pickerTitle: {
    marginTop: '8px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: 450,
    letterSpacing: '-.8px',
  },
  pickerClose: {
    marginTop: '-4px',
    marginRight: '-5px',
    marginBottom: '0',
    marginLeft: '0',
  },
  pickerIntroduction: { marginBottom: 20 },
  pickerStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    color: colors.textMuted,
    fontSize: typeScale.compact,
    marginTop: '10px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
  },
  footerStatus: { margin: 0 },
  retry: { display: 'flex', alignItems: 'center', gap: 15 },
  surface: { position: 'relative', flex: '1', minHeight: 0, margin: 1, backgroundColor: colors.inset },
  hiddenSurface: { display: 'none' },
  placeholder: {
    display: 'flex',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 13,
    padding: spacing.xxl,
    color: colors.textTertiary,
    fontSize: typeScale.body,
    lineHeight: 1.7,
    textAlign: 'center',
  },
  placeholderText: { maxWidth: 560, overflowWrap: 'anywhere' },
  placeholderErrorIcon: { color: colors.warningText },
  footer: {
    display: 'flex',
    flexShrink: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    rowGap: '9px',
    columnGap: '16px',
    minHeight: 43,
    paddingBlock: '7px',
    paddingInline: spacing.lg,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  footerButton: {
    minHeight: 27,
    paddingBlock: '0',
    paddingInline: '10px',
    fontSize: typeScale.small,
  },
  ticketForm: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: spacing.md,
    fontSize: typeScale.compact,
  },
  ticketLabel: { color: colors.textTertiary },
  detailsLink: { marginLeft: 'auto', fontSize: typeScale.small, minHeight: 27 },
  detailsLinkIcon: { flexShrink: 0 },
  browserError: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    flexBasis: '100%',
    color: colors.warningText,
    fontSize: typeScale.small,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  browserErrorIcon: { flexShrink: 0, marginTop: 2 },
  'modal-backdrop': {
    position: 'fixed',
    inset: '0',
    backgroundColor: colors.overlay,
    backdropFilter: 'blur(5px)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
    padding: '30px',
    animationDuration: '130ms',
    animationTimingFunction: 'ease-out',
    animationName: fadeIn,
  },
  appModal: {
    width: '592px',
    maxWidth: '100%',
    maxHeight: 'calc(100dvh - 60px)',
    overflow: 'auto',
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: '11px',
    boxShadow: `0 30px 100px ${colors.shadow}, 0 1px 0 ${colors.translucentSelected} inset`,
  },
  'integration-link': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover': colors.textPrimary },
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
    textDecoration: { default: 'none', ':hover': 'underline' },
    opacity: { default: 1, ':disabled': 0.4 },
  },
  'modal-header': {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: '26px',
    paddingRight: '27px',
    paddingBottom: '0',
    paddingLeft: '27px',
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: typeScale.caption,
    fontWeight: 600,
    letterSpacing: '2px',
  },
  'icon-button': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radii.md,
    color: {
      default: colors.textMuted,
      ':hover:not(:disabled)': colors.textDefault,
      "[aria-pressed='true']": colors.textDefault,
    },
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.interactive,
      "[aria-pressed='true']": colors.interactive,
    },
    opacity: { default: null, ':disabled': '.4' },
  },
  'modal-body': {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
  },
  'modal-introduction': {
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    color: colors.textMuted,
    marginTop: '11px',
    marginRight: '0',
    marginBottom: spacing.xxl,
    marginLeft: '0',
    maxWidth: '440px',
  },
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
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '7px',
    minHeight: '33px',
    paddingBlock: '0',
    paddingInline: spacing.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '5px',
    fontSize: typeScale.compact,
    fontWeight: 550,
    whiteSpace: 'nowrap',
    transition: 'background-color 140ms, color 140ms, opacity 140ms, border-color 140ms',
    opacity: { default: null, ':disabled': '.4' },
  },
  'button-secondary': {
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.hover },
    borderColor: { default: colors.borderStrong, ':hover:not(:disabled)': colors.borderSelected },
    color: colors.textDefault,
  },
});

/** The rectangle hosts isolated native views; no Jira markup enters this renderer. */
export function JiraBrowserDialog({
  reviewId,
  ticket,
  currentBranch,
  onClose,
  onDetails,
  onTicketChanged,
}: {
  reviewId: string;
  ticket: string | null;
  currentBranch?: string | null;
  onClose: () => void;
  onDetails: () => void;
  onTicketChanged: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const ticketInputId = useId();
  const {
    surface,
    ready,
    closing,
    error,
    currentTicket,
    ticketKey,
    saving,
    loadingTicket,
    ticketError,
    branchChanged,
    requestClose,
    changeTicket,
    retry,
    focus,
    editTicketKey,
  } = useJiraBrowserSession({ reviewId, ticket, currentBranch, onClose, onDetails, onTicketChanged });
  useJiraDialogFocus(dialog, () => requestClose('close'));

  return createPortal(
    <div
      className={`modal-backdrop jira-browser-backdrop ${stylex.props(styles['modal-backdrop'], styles.backdrop).className}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose('close');
      }}
    >
      <div
        ref={dialog}
        className={`modal jira-browser-modal ${!currentTicket ? 'jira-browser-picker' : ''} ${stylex.props(styles.appModal, styles.modal, !currentTicket && styles.picker).className}`}
        role="dialog"
        aria-modal="true"
        aria-label={currentTicket ? `Jira ticket ${currentTicket}` : 'Choose a Jira ticket'}
        tabIndex={-1}
      >
        <div
          ref={surface}
          className={`jira-browser-surface ${stylex.props(styles.surface, !currentTicket && styles.hiddenSurface).className}`}
          role="group"
          aria-label="Jira page controls"
          tabIndex={ready && !closing && !saving ? 0 : -1}
          onFocus={(event) => {
            if (ready && event.target === event.currentTarget) focus();
          }}
        >
          {currentTicket && !ready && (
            <div
              className={`jira-browser-placeholder ${stylex.props(styles.placeholder).className}`}
              role={error ? 'alert' : 'status'}
            >
              {error ? (
                <TriangleAlert size={20} className={stylex.props(styles.placeholderErrorIcon).className} />
              ) : currentTicket || saving || loadingTicket ? (
                <Spinner size={20} />
              ) : (
                <Ticket size={20} />
              )}
              <span {...stylex.props(styles.placeholderText)}>
                {error ||
                  (saving
                    ? 'Updating ticket…'
                    : closing
                      ? 'Closing Jira…'
                      : loadingTicket
                        ? 'Loading ticket…'
                        : currentTicket
                          ? `Opening ${currentTicket}…`
                          : 'No ticket linked')}
              </span>
              {error && (
                <div className={`jira-browser-retry ${stylex.props(styles.retry).className}`}>
                  <Button type="button" disabled={closing || saving} onClick={retry}>
                    Try again
                  </Button>
                  <button
                    type="button"
                    className={`integration-link ${stylex.props(styles['integration-link']).className}`}
                    disabled={closing || saving}
                    onClick={() => void changeTicket(null)}
                  >
                    Clear ticket
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {!currentTicket && (
          <>
            <div className={`modal-header ${stylex.props(styles['modal-header']).className}`}>
              <div>
                <span className={`eyebrow ${stylex.props(styles.eyebrow, styles.pickerEyebrow).className}`}>
                  JIRA
                </span>
                <h2 {...stylex.props(styles.pickerTitle)}>Choose a ticket</h2>
              </div>
              <button
                type="button"
                className={`icon-button ${stylex.props(styles['icon-button'], styles.pickerClose).className}`}
                aria-label="Close ticket picker"
                disabled={closing || saving}
                onClick={() => requestClose('close')}
              >
                <X size={17} />
              </button>
            </div>
            <div className={`modal-body jira-picker-body ${stylex.props(styles['modal-body']).className}`}>
              <p
                className={`modal-introduction ${stylex.props(styles['modal-introduction'], styles.pickerIntroduction).className}`}
              >
                Find a recent ticket or search by its key or title.
              </p>
              <form
                id={ticketInputId}
                className={`jira-browser-ticket-form ${stylex.props(styles.ticketForm).className}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void changeTicket(ticketKey);
                }}
              >
                <label htmlFor={`${ticketInputId}-key`} {...stylex.props(styles.ticketLabel)}>
                  Ticket
                </label>
                <JiraTicketSelect
                  id={`${ticketInputId}-key`}
                  reviewId={reviewId}
                  value={ticketKey}
                  disabled={closing || saving || loadingTicket}
                  onChange={editTicketKey}
                  onSelect={(key) => void changeTicket(key)}
                />
              </form>
              {error && (
                <p
                  className={`jira-browser-error ${stylex.props(styles.browserError).className}`}
                  role="alert"
                >
                  <TriangleAlert size={12} className={stylex.props(styles.browserErrorIcon).className} />
                  {error}
                  <button
                    type="button"
                    className={`integration-link ${stylex.props(styles['integration-link']).className}`}
                    disabled={closing || saving}
                    onClick={retry}
                  >
                    Try again
                  </button>
                </p>
              )}
              {ticketError && (
                <p
                  className={`jira-browser-error ${stylex.props(styles.browserError).className}`}
                  role="alert"
                >
                  <TriangleAlert size={12} className={stylex.props(styles.browserErrorIcon).className} />
                  {ticketError}
                </p>
              )}
              {(saving || loadingTicket) && (
                <p
                  className={`jira-picker-status ${stylex.props(styles.pickerStatus).className}`}
                  role="status"
                >
                  <Spinner size={12} />
                  {saving ? 'Opening ticket…' : 'Loading ticket…'}
                </p>
              )}
            </div>
            <div
              className={`modal-footer ${stylex.props(styles['modal-footer'], styles.pickerFooter).className}`}
            >
              <Button type="button" disabled={closing || saving} onClick={() => requestClose('close')}>
                Cancel
              </Button>
              <Button
                type="submit"
                form={ticketInputId}
                variant="primary"
                disabled={closing || saving || loadingTicket || !ticketKey.trim()}
              >
                Use ticket
              </Button>
            </div>
          </>
        )}
        {currentTicket && (
          <>
            <div className={`jira-browser-footer ${stylex.props(styles.footer).className}`}>
              {branchChanged && (
                <span
                  className={`jira-browser-error ${stylex.props(styles.browserError).className}`}
                  role="status"
                >
                  <TriangleAlert size={12} className={stylex.props(styles.browserErrorIcon).className} />
                  The checked-out branch changed. Close this ticket when you’ve finished editing.
                </span>
              )}
              {ticketError && (
                <span
                  className={`jira-browser-error ${stylex.props(styles.browserError).className}`}
                  role="alert"
                >
                  <TriangleAlert size={12} className={stylex.props(styles.browserErrorIcon).className} />
                  {ticketError}
                </span>
              )}
              {ready && error && (
                <span
                  className={`jira-browser-error ${stylex.props(styles.browserError).className}`}
                  role="alert"
                >
                  <TriangleAlert size={12} className={stylex.props(styles.browserErrorIcon).className} />
                  {error}
                </span>
              )}
              {saving && (
                <span
                  className={`jira-picker-status ${stylex.props(styles.pickerStatus, styles.footerStatus).className}`}
                  role="status"
                >
                  <Spinner size={12} />
                  Clearing ticket…
                </span>
              )}
              <button
                type="button"
                className={`integration-link jira-browser-details ${stylex.props(styles['integration-link'], styles.detailsLink).className}`}
                disabled={closing || saving}
                onClick={() => requestClose('details')}
              >
                <Ticket size={12} className={stylex.props(styles.detailsLinkIcon).className} />
                Ticket details
              </button>
              <button
                type="button"
                className={`button button-secondary ${stylex.props(styles.button, styles['button-secondary'], styles.footerButton).className}`}
                disabled={closing || saving}
                onClick={() => requestClose('close')}
              >
                {closing && <Spinner size={12} />}
                {closing ? 'Closing…' : 'Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
