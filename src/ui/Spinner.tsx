import * as stylex from '@stylexjs/stylex';
import { LoaderCircle, type LucideProps } from 'lucide-react';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });
const styles = stylex.create({
  spinner: {
    animationName: { default: spin, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: '1.1s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

export const spinStyle = styles.spinner;

export function Spinner({ className = '', ...props }: LucideProps) {
  return (
    <LoaderCircle {...props} className={`spin ${className} ${stylex.props(styles.spinner).className}`} />
  );
}
