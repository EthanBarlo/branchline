import * as stylex from '@stylexjs/stylex';
import { FolderGit2, FolderOpen, GitFork, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { DialogBody, DialogFooter, DialogIntroduction, DialogNote, Dialog as Modal } from '../../ui/Dialog';
import { errorMessage } from '../../lib/errorMessage';
import { FieldLabel, FormError, TextInput } from '../../ui/Field';
import { Spinner } from '../../ui/Spinner';
import { repositoryName } from './repositoryName';

export function AddProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
}) {
  const [repoPath, setRepoPath] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function browse() {
    setChoosing(true);
    setError(null);
    try {
      const path = await window.reviewAPI.chooseRepo();
      if (alive.current && path) setRepoPath(path);
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
    } finally {
      if (alive.current) setChoosing(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!repoPath.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await window.reviewAPI.createProject({
        repoPath: repoPath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      if (alive.current) await onCreated(created);
    } catch (reason) {
      if (alive.current) {
        setError(errorMessage(reason));
        setSaving(false);
      }
    }
  }

  return (
    <Modal title="Add a project" onClose={() => !saving && onClose()}>
      <form onSubmit={(event) => void create(event)}>
        <DialogBody className="add-project-form">
          <DialogIntroduction>
            Give your repository a place in your workspace. Its reviews, comments, and target branch stay
            together.
          </DialogIntroduction>
          <FieldLabel htmlFor="project-repo-path">Repository path</FieldLabel>
          <div className={`repository-input-row ${stylex.props(styles.repositoryInputRow).className}`}>
            <div className={`input-with-icon ${stylex.props(styles.inputWithIcon).className}`}>
              <FolderGit2 size={16} className={stylex.props(styles.repositoryInputIcon).className} />
              <input
                id="project-repo-path"
                {...stylex.props(styles.repositoryInput)}
                placeholder="/path/to/your/repository"
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
                disabled={saving || choosing}
              />
            </div>
            <Button
              type="button"
              className={stylex.props(styles.repositoryBrowseButton).className}
              onClick={() => void browse()}
              disabled={saving || choosing}
            >
              {choosing ? <Spinner size={15} /> : <FolderOpen size={15} />}Browse
            </Button>
          </div>
          <FieldLabel htmlFor="project-name">
            Project name{' '}
            <span className={`inline-optional ${stylex.props(styles.optionalLabel).className}`}>
              Optional
            </span>
          </FieldLabel>
          <TextInput
            id="project-name"
            placeholder={repoPath ? repositoryName(repoPath) : 'e.g. Platform'}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
          <div className={`project-folder-note ${stylex.props(styles.projectFolderNote).className}`}>
            <GitFork size={17} className={stylex.props(styles.projectFolderIcon).className} />
            <p {...stylex.props(styles.projectFolderDescription)}>
              Point to the parent repository. Initialized submodules are included automatically when you start
              a review.
            </p>
          </div>
          {error && <FormError>{error}</FormError>}
        </DialogBody>
        <DialogFooter>
          <DialogNote>
            <ShieldCheck size={13} />
            Saved on this device
          </DialogNote>
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!repoPath.trim() || saving || choosing}>
            {saving ? <Spinner size={15} /> : <Plus size={16} />}
            {saving ? 'Adding project…' : 'Add project'}
          </Button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

const styles = stylex.create({
  repositoryInputRow: { display: 'flex', alignItems: 'stretch', gap: spacing.md },
  inputWithIcon: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    flex: '1',
    minWidth: 0,
    paddingInline: spacing.lg,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
  },
  projectFolderNote: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radii.md,
    backgroundColor: colors.panel,
  },
  repositoryInputIcon: { flexShrink: 0, color: colors.textMuted },
  repositoryInput: {
    width: '100%',
    minWidth: 0,
    backgroundColor: 'transparent',
    outline: 'none',
    borderWidth: 0,
    paddingBlock: '9px',
    paddingInline: '0',
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    color: colors.textDefault,
    '::placeholder': { color: colors.textFaint, opacity: 1 },
  },
  repositoryBrowseButton: { minHeight: 37 },
  optionalLabel: {
    display: 'inline',
    marginTop: spacing.xs,
    marginLeft: 5,
    fontSize: typeScale.caption,
    fontWeight: 400,
    color: colors.textQuiet,
  },
  projectFolderIcon: { flexShrink: 0, marginTop: 3 },
  projectFolderDescription: {
    margin: 0,
    fontSize: typeScale.small,
    lineHeight: 1.8,
    color: colors.textMuted,
  },
});
