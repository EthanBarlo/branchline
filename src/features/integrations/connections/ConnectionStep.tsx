import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { colors, fonts, spacing, typeScale } from '../../../theme/tokens.stylex';

const styles = stylex.create({
  step: {
    display: 'grid',
    gridTemplateColumns: '27px minmax(0, 1fr)',
    gap: 14,
    paddingTop: '0',
    paddingRight: '0',
    paddingBottom: '27px',
    paddingLeft: '0',
  },
  stepAfterFirst: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    paddingTop: 25,
  },
  stepLast: { paddingBottom: 0 },
  stepNumber: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 25,
    height: 25,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: 5,
    color: colors.textTertiary,
    backgroundColor: colors.surface,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  stepContent: { minWidth: 0 },
  stepHeading: {
    marginTop: spacing.xs,
    marginRight: '0',
    marginBottom: '13px',
    marginLeft: '0',
    fontSize: typeScale.body,
    fontWeight: 550,
  },
});

export function ConnectionStep({
  number,
  title,
  children,
}: {
  number: 1 | 2 | 3;
  title: string;
  children: ReactNode;
}) {
  return (
    <li {...stylex.props(styles.step, number > 1 && styles.stepAfterFirst, number === 3 && styles.stepLast)}>
      <span {...stylex.props(styles.stepNumber)} aria-hidden="true">
        {number}
      </span>
      <div {...stylex.props(styles.stepContent)}>
        <h4 {...stylex.props(styles.stepHeading)}>{title}</h4>
        {children}
      </div>
    </li>
  );
}
