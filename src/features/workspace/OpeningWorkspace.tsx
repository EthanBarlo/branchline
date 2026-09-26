import * as stylex from '@stylexjs/stylex';
import { colors, typeScale } from '../../tokens.stylex';
import { Spinner } from '../../ui/Spinner';

export function OpeningWorkspace({ projectName }: { projectName?: string }) {
  return (
    <div className={`central-empty ${stylex.props(styles['central-empty']).className}`}>
      <Spinner size={projectName ? 24 : 28} />
      {projectName ? (
        <>
          <h2 {...stylex.props(styles.centralTitle)}>Opening Current</h2>
          <p {...stylex.props(styles.centralDescription)}>Reading the branch checked out in {projectName}.</p>
        </>
      ) : (
        <p {...stylex.props(styles.centralDescription)}>Opening your workspace…</p>
      )}
    </div>
  );
}

const styles = stylex.create({
  'central-empty': {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '9px',
    padding: '30px',
    textAlign: 'center',
    color: colors.textMuted,
  },
  centralTitle: {
    marginTop: '7px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textDefault,
    fontSize: 19,
    fontWeight: 500,
    letterSpacing: '-.35px',
  },
  centralDescription: {
    maxWidth: 320,
    margin: 0,
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
  },
});
