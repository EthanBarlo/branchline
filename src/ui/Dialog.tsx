import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { colors, radii, spacing, typeScale } from '../tokens.stylex';

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: 30,
    backgroundColor: colors.overlay,
    backdropFilter: 'blur(5px)',
    animationName: fadeIn,
    animationDuration: '130ms',
    animationTimingFunction: 'ease-out',
  },
  dialog: {
    width: 592,
    maxWidth: '100%',
    maxHeight: 'calc(100dvh - 60px)',
    overflow: 'auto',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: 11,
    boxShadow: `0 30px 100px ${colors.shadow}, 0 1px 0 ${colors.translucentSelected} inset`,
  },
  small: { width: 440 },
  integration: { width: 700, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  integrationWide: { width: 720 },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: 26,
    paddingRight: 27,
    paddingBottom: 0,
    paddingLeft: 27,
  },
  integrationHeader: { flexShrink: 0, paddingBottom: 18 },
  eyebrow: { color: colors.textSubtle, fontSize: typeScale.micro, fontWeight: 600, letterSpacing: '1.7px' },
  title: {
    marginTop: spacing.md,
    marginRight: 0,
    marginBottom: 0,
    marginLeft: 0,
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: 450,
    letterSpacing: '-.8px',
  },
  integrationTitle: { fontSize: 24 },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
    marginRight: -5,
    marginBottom: 0,
    marginLeft: 0,
    padding: spacing.sm,
    borderWidth: 0,
    borderRadius: radii.md,
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.interactive },
    color: { default: colors.textMuted, ':hover:not(:disabled)': colors.textDefault },
    opacity: { default: 1, ':disabled': 0.4 },
  },
  body: { paddingTop: 0, paddingRight: 27, paddingBottom: spacing.xxl, paddingLeft: 27 },
  intro: {
    maxWidth: 440,
    marginTop: 11,
    marginRight: 0,
    marginBottom: spacing.xxl,
    marginLeft: 0,
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 9,
    paddingBlock: 17,
    paddingInline: 27,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  localNote: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    marginRight: 'auto',
    color: colors.textMuted,
    fontSize: typeScale.micro,
  },
});

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  small?: boolean;
  wide?: boolean;
  variant?: 'standard' | 'integration';
}

export function Dialog({
  title,
  onClose,
  children,
  busy = false,
  small = false,
  wide = false,
  variant = 'standard',
}: DialogProps) {
  const titleId = useId();
  const container = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = () => {
    if (!busy) onClose();
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ) || [],
      ).filter((item) => item.offsetParent !== null);
    focusables()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || container.current?.offsetParent === null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, []);

  const integration = variant === 'integration';
  const content = (
    <div
      className={`modal-backdrop ${integration ? 'integration-backdrop' : ''} ${stylex.props(styles.backdrop).className}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close.current();
      }}
    >
      <div
        ref={container}
        className={`modal ${stylex.props(styles.dialog, small && styles.small, integration && styles.integration, wide && styles.integrationWide).className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div
          className={`modal-header ${stylex.props(styles.header, integration && styles.integrationHeader).className}`}
        >
          <div>
            <span className={`eyebrow ${stylex.props(styles.eyebrow).className}`}>
              {integration ? 'BRANCHLINE · CONNECTED REVIEW' : 'BRANCHLINE'}
            </span>
            <h2 id={titleId} {...stylex.props(styles.title, integration && styles.integrationTitle)}>
              {title}
            </h2>
          </div>
          <button
            type="button"
            className={`icon-button ${stylex.props(styles.close).className}`}
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={integration ? 18 : 19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return integration ? createPortal(content, document.body) : content;
}

export function DialogBody({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`modal-body ${className} ${stylex.props(styles.body).className}`} />;
}

export function DialogFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`modal-footer ${className} ${stylex.props(styles.footer).className}`} />;
}

export function DialogIntroduction({ className = '', ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p {...props} className={`modal-introduction ${className} ${stylex.props(styles.intro).className}`} />
  );
}

export function DialogNote({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={`modal-local-note ${className} ${stylex.props(styles.localNote).className}`}
    />
  );
}
