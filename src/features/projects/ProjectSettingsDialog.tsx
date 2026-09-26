import * as stylex from '@stylexjs/stylex';
import { Check, FolderGit2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';
import { DialogBody, DialogFooter, Dialog as Modal } from '../../ui/Dialog';
import { errorMessage } from '../../ui/errorMessage';
import { FieldLabel, FormError, TextInput } from '../../ui/Field';
import { Spinner } from '../../ui/Spinner';

export function ProjectSettingsDialog({
  project,
  currentTarget,
  onClose,
  onUpdated,
  onRemove,
}: {
  project: Project;
  currentTarget: string;
  onClose: () => void;
  onUpdated: (project: Project) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onUpdated(await window.reviewAPI.updateProject(project.id, { name: name.trim() }));
    } catch (reason) {
      setError(errorMessage(reason));
      setSaving(false);
    }
  }
  return (
    <Modal title="Project settings" onClose={() => !saving && onClose()}>
      <form onSubmit={(event) => void save(event)}>
        <DialogBody className="project-settings-form">
          <FieldLabel htmlFor="settings-project-name">Project name</FieldLabel>
          <TextInput
            id="settings-project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
          <div className={`settings-project-location ${stylex.props(styles.projectLocation).className}`}>
            <FolderGit2 size={16} className={stylex.props(styles.settingsProjectIcon).className} />
            <span {...stylex.props(styles.settingsProjectPath)}>{project.repoPath}</span>
          </div>
          <div className={`settings-target ${stylex.props(styles.target).className}`}>
            <span {...stylex.props(styles.settingsTargetLabel)}>Current target</span>
            <code {...stylex.props(styles.settingsTargetCode)}>{currentTarget || 'Not selected'}</code>
            <p {...stylex.props(styles.settingsTargetDescription)}>
              Choose or change the target in Current. It stays selected as you switch branches.
            </p>
          </div>
          {error && <FormError>{error}</FormError>}
          <div className={`remove-project-setting ${stylex.props(styles.removeSetting).className}`}>
            <div {...stylex.props(styles.removeProjectContent)}>
              <strong {...stylex.props(styles.removeProjectTitle)}>Remove project</strong>
              <span {...stylex.props(styles.removeProjectDescription)}>
                Remove its saved reviews and feedback from Branchline.
              </span>
            </div>
            <Button
              type="button"
              className={`button-remove-project ${stylex.props(styles.removeButton).className}`}
              onClick={onRemove}
              disabled={saving}
            >
              <Trash2 size={14} />
              Remove…
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            {saving ? <Spinner size={15} /> : <Check size={15} />}Save changes
          </Button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

const styles = stylex.create({
  projectLocation: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
    color: colors.textMuted,
  },
  target: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: radii.md,
    backgroundColor: colors.panel,
  },
  removeSetting: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    marginTop: spacing.xxl,
    paddingTop: spacing.xl,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  removeButton: {
    flexShrink: 0,
    color: colors.dangerText,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  settingsProjectIcon: { flexShrink: 0 },
  settingsProjectPath: {
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  settingsTargetLabel: { color: colors.textEmphasis },
  settingsTargetCode: {
    marginLeft: 'auto',
    color: colors.textDefault,
    backgroundColor: colors.interactive,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.md,
    paddingBlock: '5px',
    paddingInline: '7px',
    fontSize: typeScale.caption,
  },
  settingsTargetDescription: { color: colors.textMuted, fontSize: typeScale.small, width: '100%', margin: 0 },
  removeProjectContent: { display: 'flex', flexDirection: 'column', gap: 5 },
  removeProjectTitle: { color: colors.textSecondary, fontSize: typeScale.compact, fontWeight: 500 },
  removeProjectDescription: { color: colors.textQuiet, fontSize: typeScale.caption, lineHeight: 1.6 },
});
