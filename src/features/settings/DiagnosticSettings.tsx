import * as stylex from '@stylexjs/stylex';
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IntegrationDiagnosticsInfo } from '../../../shared/integrations';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { FormError } from '../../ui/Field';
import { Spinner } from '../../ui/Spinner';

const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error);

const styles = stylex.create({
  heading: { marginBottom: 31 },
  kicker: {
    color: colors.textQuiet,
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    letterSpacing: '1.3px',
  },
  title: {
    marginTop: '12px',
    marginRight: '0',
    marginBottom: '10px',
    marginLeft: '0',
    fontSize: 28,
    fontWeight: 500,
    letterSpacing: '-.8px',
  },
  introduction: { margin: 0, fontSize: typeScale.body, lineHeight: 1.8, color: colors.textMuted },
  card: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: 7,
    backgroundColor: colors.panel,
    padding: 25,
  },
  cardTitle: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '14px',
    marginLeft: '0',
    color: colors.accent,
    fontSize: 14,
    fontWeight: 500,
  },
  cardParagraph: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '15px',
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.body,
    lineHeight: 1.8,
  },
  loading: { display: 'flex', alignItems: 'center', gap: 7 },
  path: {
    paddingBlock: '15px',
    paddingInline: '0',
    marginTop: '5px',
    marginRight: '0',
    marginBottom: '12px',
    marginLeft: '0',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  pathLabel: {
    display: 'block',
    marginBottom: spacing.md,
    fontSize: typeScale.small,
    color: colors.textQuiet,
  },
  pathValue: {
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    color: colors.textEmphasis,
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: 22 },
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
});

export function DiagnosticSettings({ visible }: { visible: boolean }) {
  const [info, setInfo] = useState<IntegrationDiagnosticsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.reviewAPI
      .getIntegrationDiagnostics()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  async function openLog() {
    if (opening) return;
    setOpening(true);
    setError('');
    try {
      await window.reviewAPI.openIntegrationLog();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <header className={`settings-page-heading ${stylex.props(styles.heading).className}`}>
        <span className={`settings-kicker ${stylex.props(styles.kicker).className}`}>TROUBLESHOOTING</span>
        <h2 {...stylex.props(styles.title)}>Diagnostics</h2>
        <p {...stylex.props(styles.introduction)}>
          Find the details behind Jira and Bitbucket connection or review errors.
        </p>
      </header>
      <div className={`settings-diagnostics-card ${stylex.props(styles.card).className}`}>
        <h3 {...stylex.props(styles.cardTitle)}>Integration log</h3>
        <p {...stylex.props(styles.cardParagraph)}>
          Branchline automatically records request statuses, timing and response validation details on this
          device. Tokens, authorization headers and response bodies are excluded.
        </p>
        <p {...stylex.props(styles.cardParagraph)}>
          Retry the action that failed, then open the log to inspect the latest entries.
        </p>
        {loading && (
          <p
            className={`settings-diagnostics-loading ${stylex.props(styles.cardParagraph, styles.loading).className}`}
            role="status"
          >
            <Spinner size={13} />
            Checking the log…
          </p>
        )}
        {!loading && info?.path && (
          <div className={`settings-diagnostics-path ${stylex.props(styles.path).className}`}>
            <span {...stylex.props(styles.pathLabel)}>Log file</span>
            <code {...stylex.props(styles.pathValue)}>{info.path}</code>
          </div>
        )}
        {!loading && info && !info.available && (
          <p {...stylex.props(styles.cardParagraph)} role="status">
            The log is not available yet. Retry the connection or pull request, then reopen this tab.
          </p>
        )}
        {error && <FormError>{error}</FormError>}
        <div className={`settings-diagnostics-actions ${stylex.props(styles.actions).className}`}>
          <button
            className={`button ${stylex.props(styles['button']).className}`}
            type="button"
            disabled={loading || opening || !info?.available}
            onClick={() => void openLog()}
          >
            {opening ? <Spinner size={13} /> : <FolderOpen size={13} />}Open integration log
          </button>
        </div>
      </div>
    </>
  );
}
