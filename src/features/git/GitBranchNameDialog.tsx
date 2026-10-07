import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import type { GitActionInput, GitActionPreview } from '../../../shared/git-workflow';
import type { GitSidebarBranch } from './branchTree';
import { errorMessage } from '../../lib/errorMessage';
import { colors, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog, DialogBody, DialogFooter } from '../../ui/Dialog';
import { FieldLabel, FormError, TextInput } from '../../ui/Field';
import { Select } from '../../ui/Select';

export function GitBranchNameDialog({
  projectId,
  branch,
  action,
  initialRemote,
  onClose,
  onPrepared,
}: {
  projectId: string;
  branch: GitSidebarBranch;
  action: 'create' | 'rename';
  initialRemote: string;
  onClose: () => void;
  onPrepared: (preview: GitActionPreview) => void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [name, setName] = useState(action === 'rename' ? branch.name : '');
  const [remote, setRemote] = useState(initialRemote);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const remotes = [...new Set(branch.repositories.flatMap((repo) => repo.remotes))].sort();
  async function prepare() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(undefined);
    try {
      const input: GitActionInput = {
        action,
        branch: {
          name: branch.name,
          kind: branch.remote ? 'remote' : 'local',
          ...(remote ? { remote } : {}),
        },
        newBranch: name.trim(),
      };
      const preview = await window.reviewAPI.previewGitAction(projectId, input);
      if (!active.current) return;
      if (preview.ready) {
        onPrepared(preview);
        return;
      }
      // Keep the dialog open so the name can be corrected without starting over.
      setError(
        [
          ...new Set(
            preview.rows.flatMap((row) =>
              row.blockers.map((blocker) => (row.path === '.' ? blocker : `${row.path}: ${blocker}`)),
            ),
          ),
        ].join(' '),
      );
      setPending(false);
    } catch (reason) {
      setError(errorMessage(reason));
      setPending(false);
    }
  }
  return (
    <Dialog title={action === 'create' ? 'New branch' : 'Rename branch'} onClose={onClose} busy={pending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void prepare();
        }}
      >
        <DialogBody>
          <p {...stylex.props(styles.note)}>
            {action === 'create' ? (
              <>
                Create a local branch in every repository from{' '}
                <strong>
                  {branch.remote ? `${branch.remote}/` : ''}
                  {branch.name}
                </strong>
                . Your checked-out branches stay the same.
              </>
            ) : (
              <>
                Rename{' '}
                <strong>
                  {branch.remote ? `${branch.remote}/` : ''}
                  {branch.name}
                </strong>{' '}
                in every repository. Existing remote branch names and upstream tracking are retained.
              </>
            )}
          </p>
          <FieldLabel htmlFor="git-branch-name">
            {action === 'create' ? 'Branch name' : 'New branch name'}
          </FieldLabel>
          <TextInput
            id="git-branch-name"
            value={name}
            disabled={pending}
            autoFocus
            placeholder="feature/my-branch"
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => {
              if (action === 'rename') event.target.select();
            }}
            onChange={(event) => setName(event.target.value)}
          />
          {action === 'create' && remotes.length > 1 && (
            <div {...stylex.props(styles.remote)}>
              <FieldLabel>Source remote</FieldLabel>
              <Select
                label="New branch source remote"
                value={remote}
                disabled={pending}
                options={[
                  { value: '', label: 'Resolve per repository' },
                  ...remotes.map((value) => ({ value, label: value })),
                ]}
                onChange={setRemote}
              />
            </div>
          )}
          {error && <FormError>{error}</FormError>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !name.trim() || (action === 'rename' && name.trim() === branch.name)}
          >
            {action === 'create' ? 'Create branch' : 'Rename branch'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
const styles = stylex.create({
  note: {
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  remote: { marginTop: spacing.lg },
});
