import * as stylex from '@stylexjs/stylex';
import type { ButtonHTMLAttributes } from 'react';
import { colors, typeScale } from '../../../theme/tokens.stylex';

const styles = stylex.create({
  textButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 5,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover:not(:disabled)': colors.textPrimary },
    fontSize: typeScale.small,
    lineHeight: 1.6,
    textDecoration: { default: 'none', ':hover:not(:disabled)': 'underline' },
    textUnderlineOffset: { default: null, ':hover:not(:disabled)': 3 },
    opacity: { default: 1, ':disabled': 0.4 },
  },
});

type ConnectionTextButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  xstyle?: stylex.StyleXStyles;
};

export function ConnectionTextButton({
  xstyle,
  className = '',
  type = 'button',
  ...props
}: ConnectionTextButtonProps) {
  const textStyle = stylex.props(styles.textButton, xstyle);
  return <button {...props} type={type} className={`${textStyle.className} ${className}`} />;
}
