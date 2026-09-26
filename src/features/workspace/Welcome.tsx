import * as stylex from '@stylexjs/stylex';
import { FolderOpen } from 'lucide-react';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { Brand } from '../../ui/Brand';
import { Button } from '../../ui/Button';

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
  welcomeTitle: {
    marginTop: spacing.md,
    marginRight: '0',
    marginBottom: '5px',
    marginLeft: '0',
    fontSize: 24,
    lineHeight: 1.3,
    letterSpacing: '-.6px',
    fontWeight: 450,
    color: colors.textDefault,
  },
  centralDescription: {
    maxWidth: 320,
    margin: 0,
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
  },
  welcomeDescription: { maxWidth: 350, fontSize: typeScale.body },
  welcomeButton: { marginTop: 13 },
});

export function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={`central-empty welcome-simple ${stylex.props(styles['central-empty']).className}`}>
      <Brand small />
      <h1 {...stylex.props(styles.welcomeTitle)}>Review your local changes.</h1>
      <p {...stylex.props(styles.centralDescription, styles.welcomeDescription)}>
        Choose a Git repository to review your branch and its submodules.
      </p>
      <Button variant="primary" className={stylex.props(styles.welcomeButton).className} onClick={onCreate}>
        <FolderOpen size={15} />
        Add your first project
      </Button>
    </div>
  );
}
