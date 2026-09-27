import * as stylex from '@stylexjs/stylex';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { colors, radii, spacing, typeScale } from '../theme/tokens.stylex';

const styles = stylex.create({
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 33,
    paddingBlock: 0,
    paddingInline: spacing.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 5,
    fontSize: typeScale.compact,
    fontWeight: 550,
    whiteSpace: 'nowrap',
    transition: 'background-color 140ms, color 140ms, opacity 140ms, border-color 140ms',
    opacity: { default: 1, ':disabled': 0.4 },
  },
  primary: {
    backgroundColor: { default: colors.accent, ':hover:not(:disabled)': colors.textPrimary },
    borderColor: { default: colors.accent, ':hover:not(:disabled)': colors.textPrimary },
    color: colors.textInverse,
  },
  copied: { backgroundColor: colors.textSecondary },
  secondary: {
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.hover },
    borderColor: { default: colors.borderStrong, ':hover:not(:disabled)': colors.borderSelected },
    color: colors.textDefault,
  },
  danger: {
    backgroundColor: { default: colors.dangerButton, ':hover:not(:disabled)': colors.dangerButtonHover },
    borderColor: colors.dangerBorder,
    color: colors.dangerStrong,
  },
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm,
    borderWidth: 0,
    borderRadius: radii.md,
    color: {
      default: colors.textMuted,
      ':hover:not(:disabled)': colors.textDefault,
      '[aria-pressed="true"]': colors.textDefault,
    },
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.interactive,
      '[aria-pressed="true"]': colors.interactive,
    },
    opacity: { default: 1, ':disabled': 0.4 },
  },
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  copied?: boolean;
  xstyle?: stylex.StyleXStyles;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', copied = false, xstyle, className = '', ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      className={`button button-${variant} ${copied ? 'is-copied' : ''} ${className} ${stylex.props(styles.button, styles[variant], copied && styles.copied, xstyle).className}`}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function IconButton({ className = '', ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        className={`icon-button ${className} ${stylex.props(styles.icon).className}`}
      />
    );
  },
);
