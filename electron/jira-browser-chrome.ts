import * as stylex from '@stylexjs/stylex';
import '../src/styles.css';
import { applyTheme } from '../src/theme';
import { colors, spacing, typeScale } from '../src/tokens.stylex';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    color: colors.textDefault,
    backgroundColor: colors.jiraChromeBackground,
  },
  body: { margin: 0, overflow: 'hidden' },
  header: { borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: colors.border },
  top: { height: 47, paddingInline: spacing.lg, display: 'flex', gap: spacing.sm, alignItems: 'center' },
  badge: {
    display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, height: 30,
    paddingTop: 0, paddingRight: 3, paddingBottom: 0, paddingLeft: 9,
    marginBlock: 0, marginInline: spacing.xs,
    borderWidth: 1, borderStyle: 'solid', borderColor: colors.highlight,
    borderRadius: 5, backgroundColor: colors.surface,
  },
  ticket: { fontSize: typeScale.base, fontWeight: 600, margin: 0, whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' },
  button: {
    cursor: { default: 'pointer', ':disabled': 'default' },
    backgroundColor: { default: 'transparent', ':hover': colors.raised, ':disabled:hover': 'transparent' },
    borderWidth: 1, borderStyle: 'solid',
    borderColor: { default: 'transparent', ':hover': colors.highlight, ':disabled:hover': 'transparent' },
    borderRadius: 5, color: 'inherit', fontFamily: 'inherit', fontSize: typeScale.body,
    height: 30, paddingBlock: 0, paddingInline: 9, whiteSpace: 'nowrap',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    flexShrink: 0, opacity: { default: 1, ':disabled': 0.4 },
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid', outlineColor: colors.focus, outlineOffset: 2,
  },
  iconButton: { padding: 0, width: 30 },
  badgeButton: {
    width: 24, height: 24,
    color: { default: colors.textMuted, ':hover': colors.textDefault },
  },
  buttonIcon: {
    height: 15, width: 15, stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none',
  },
  external: { backgroundColor: colors.surface, borderColor: colors.highlight },
  origin: {
    flex: '1', minWidth: 140, marginRight: spacing.md, color: colors.textMuted,
    fontSize: typeScale.body, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  statusRow: {
    paddingBlock: spacing.md, paddingInline: 14,
    borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: colors.interactive,
    maxHeight: 112, overflowY: 'auto',
  },
  status: { margin: 0, fontSize: typeScale.body, lineHeight: '17px', color: colors.textSubtle, overflowWrap: 'anywhere' },
  error: { color: colors.dangerText },
  loading: {
    width: 10, height: 10, flexShrink: 0,
    borderWidth: 1.5, borderStyle: 'solid', borderColor: colors.borderSelected,
    borderTopColor: colors.textEmphasis, borderRadius: '50%',
    animationName: { default: spin, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '1s', animationTimingFunction: 'linear', animationIterationCount: 'infinite',
  },
});

function setStyles(selector: string, value: stylex.CompiledStyles): void {
  const className = stylex.props(value).className;
  if (!className) return;
  for (const element of document.querySelectorAll(selector)) element.classList.add(...className.split(' '));
}

setStyles('html', styles.root);
setStyles('body', styles.body);
setStyles('header', styles.header);
setStyles('.top', styles.top);
setStyles('.ticket-badge', styles.badge);
setStyles('#ticket', styles.ticket);
for (const button of document.querySelectorAll('button')) {
  const className = stylex.props(
    styles.button,
    button.classList.contains('icon') && styles.iconButton,
    button.closest('.ticket-badge') !== null && styles.badgeButton,
    button.classList.contains('external') && styles.external,
  ).className;
  if (className) button.classList.add(...className.split(' '));
}
setStyles('button svg', styles.buttonIcon);
setStyles('#origin', styles.origin);
setStyles('.status-row', styles.statusRow);
setStyles('#loading', styles.loading);

const root = document.documentElement;
const status = document.getElementById('status')!;
const initialTheme = (window as Window & { branchlineJiraInitialTheme?: 'light' | 'dark' }).branchlineJiraInitialTheme;
let theme: string | undefined = initialTheme;
applyTheme(initialTheme === 'dark' ? 'dark' : 'light');

function syncState(): void {
  if (root.dataset.theme !== theme) {
    theme = root.dataset.theme;
    applyTheme(theme === 'dark' ? 'dark' : 'light');
  }
  status.className = stylex.props(styles.status, status.dataset.error === 'true' && styles.error).className ?? '';
}

new MutationObserver(syncState).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
new MutationObserver(syncState).observe(status, { attributes: true, attributeFilter: ['data-error'] });
syncState();
