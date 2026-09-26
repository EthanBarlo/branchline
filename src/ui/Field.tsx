import * as stylex from '@stylexjs/stylex';
import { TriangleAlert } from 'lucide-react';
import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from 'react';
import { colors, radii, spacing, typeScale } from '../tokens.stylex';

const styles = stylex.create({
  label: {
    display: 'block',
    fontSize: typeScale.compact,
    fontWeight: 500,
    color: colors.textDefault,
    marginTop: 18,
    marginRight: 0,
    marginBottom: spacing.md,
    marginLeft: 0,
  },
  input: {
    width: '100%',
    minHeight: 37,
    paddingBlock: 0,
    paddingInline: 11,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: 5,
    borderColor: { default: colors.borderStrong, ':focus': colors.textSubtle },
    color: colors.textDefault,
    fontSize: typeScale.compact,
    '::placeholder': { color: colors.textFaint, opacity: 1 },
  },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: 18,
    padding: 10,
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.warningRaised,
    borderRadius: radii.md,
    fontSize: typeScale.small,
    color: colors.warningText,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  errorIcon: { flexShrink: 0, marginTop: 1 },
});

export const FieldLabel = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function FieldLabel({ className = '', ...props }, ref) {
    return (
      <label
        {...props}
        ref={ref}
        className={`field-label ${className} ${stylex.props(styles.label).className}`}
      />
    );
  },
);

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={`text-input ${className} ${stylex.props(styles.input).className}`}
      />
    );
  },
);

export function FormError({
  children,
  action,
  className = '',
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`form-error ${className} ${stylex.props(styles.error).className}`} role="alert">
      <TriangleAlert size={15} {...stylex.props(styles.errorIcon)} />
      <span>{children}</span>
      {action}
    </div>
  );
}
