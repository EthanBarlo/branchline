import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, FolderGit2, GitBranch, GitCompareArrows, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project, RepoInspection, Review } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { DialogFooter, DialogNote, Dialog as Modal } from '../../ui/Dialog';
import { errorMessage } from '../../lib/errorMessage';
import { FormError, TextInput } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';

export function NewReviewDialog({
  project,
  onClose,
  onCreated,
}: {
  project: Project;
  onClose: () => void;
  onCreated: (review: Review) => void;
}) {
  const [inspection, setInspection] = useState<RepoInspection | null>(null);
  const [inspecting, setInspecting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseBranch, setBaseBranch] = useState(project.defaultBaseBranch || '');
  const [featureBranch, setFeatureBranch] = useState('');
  const [name, setName] = useState('');
  const [includeWorkingTree, setIncludeWorkingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setInspecting(true);
    setError(null);
    window.reviewAPI
      .inspectRepo(project.repoPath)
      .then((result) => {
        if (!cancelled) setInspection(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.repoPath, inspectionAttempt]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!inspection || saving || !baseBranch.trim() || !featureBranch.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.reviewAPI.createReview({
        projectId: project.id,
        baseBranch: baseBranch.trim(),
        featureBranch: featureBranch.trim(),
        includeWorkingTree,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      if (alive.current) onCreated(result);
    } catch (reason) {
      if (alive.current) {
        setError(errorMessage(reason));
        setSaving(false);
      }
    }
  }

  return (
    <Modal title="Review another branch" onClose={() => !saving && onClose()}>
      <form onSubmit={(event) => void create(event)}>
        <div
          className={`modal-body new-review-form saved-review-form ${stylex.props(styles['modal-body']).className}`}
        >
          <p
            className={`modal-introduction ${stylex.props(styles['modal-introduction'], styles.newReviewIntroduction).className}`}
          >
            Create a separate review for a specific branch. It stays on that branch when your checkout
            changes.
          </p>
          <div
            className={`review-project-context ${stylex.props(styles['review-project-context']).className}`}
          >
            <FolderGit2 size={16} className={stylex.props(styles.reviewProjectIcon).className} />
            <strong {...stylex.props(styles.reviewProjectName)}>{project.name}</strong>
            <span title={project.repoPath} {...stylex.props(styles.reviewProjectPath)}>
              {project.repoPath}
            </span>
          </div>
          {inspecting && (
            <div className={`saved-review-loading ${stylex.props(styles['saved-review-loading']).className}`}>
              <Spinner size={13} />
              Reading available branches…
            </div>
          )}
          <div
            className={`branch-fields ${stylex.props(styles['branch-fields'], styles.savedReviewBranchFields).className}`}
          >
            <div {...stylex.props(styles.branchField)}>
              <label
                className={`field-label ${stylex.props(styles['field-label'], styles.newReviewFieldLabel).className}`}
                htmlFor="base-branch"
              >
                Target branch
              </label>
              <Select
                id="base-branch"
                className={`branch-picker ${stylex.props(styles['branch-picker']).className}`}
                variant="field"
                triggerStyle={styles.codeTrigger}
                label="Target branch"
                icon={<GitBranch size={15} />}
                placeholder="Choose target branch"
                searchPlaceholder="Find a branch…"
                value={baseBranch}
                options={(inspection?.branches || []).map((branch) => ({ value: branch, label: branch }))}
                onChange={setBaseBranch}
                disabled={!inspection || saving}
              />
            </div>
            <ArrowLeft
              className={`branch-fields-arrow ${stylex.props(styles['branch-fields-arrow']).className}`}
              size={15}
            />
            <div {...stylex.props(styles.branchField)}>
              <label
                className={`field-label ${stylex.props(styles['field-label'], styles.newReviewFieldLabel).className}`}
                htmlFor="feature-branch"
              >
                Feature branch
              </label>
              <Select
                id="feature-branch"
                className={`branch-picker ${stylex.props(styles['branch-picker']).className}`}
                variant="field"
                triggerStyle={styles.codeTrigger}
                label="Feature branch"
                icon={<GitBranch size={15} />}
                placeholder="Choose feature branch"
                searchPlaceholder="Find a branch…"
                value={featureBranch}
                options={(inspection?.branches || []).map((branch) => ({ value: branch, label: branch }))}
                onChange={setFeatureBranch}
                disabled={!inspection || saving}
              />
            </div>
          </div>
          <div className={`merge-base-note ${stylex.props(styles['merge-base-note']).className}`}>
            <GitCompareArrows size={16} className={stylex.props(styles.mergeBaseIcon).className} />
            <p {...stylex.props(styles.mergeBaseDescription)}>
              Only changes introduced by the feature branch are shown. Changes made only on the target are
              excluded.
            </p>
          </div>
          <label
            className={`field-label ${stylex.props(styles['field-label'], styles.newReviewFieldLabel).className}`}
            htmlFor="review-name"
          >
            Review name{' '}
            <span className={`inline-optional ${stylex.props(styles.optionalLabel).className}`}>
              Optional
            </span>
          </label>
          <TextInput
            id="review-name"
            placeholder={featureBranch || 'Name this review'}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={saving}
          />
          <label className={`working-tree-option ${stylex.props(styles['working-tree-option']).className}`}>
            <input
              type="checkbox"
              {...stylex.props(styles.workingTreeCheckbox)}
              checked={includeWorkingTree}
              onChange={(event) => setIncludeWorkingTree(event.target.checked)}
              disabled={saving}
            />
            <span {...stylex.props(styles.workingTreeContent)}>
              <strong {...stylex.props(styles.workingTreeTitle)}>Include uncommitted changes</strong>
              <span {...stylex.props(styles.workingTreeDescription)}>
                Include local edits and new files when this feature branch is checked out.
              </span>
            </span>
          </label>
          {error && (
            <FormError
              action={
                !inspection && (
                  <button
                    type="button"
                    {...stylex.props(styles.formErrorRetry)}
                    onClick={() => setInspectionAttempt((previous) => previous + 1)}
                  >
                    Retry
                  </button>
                )
              }
            >
              {error}
            </FormError>
          )}
        </div>
        <DialogFooter>
          <DialogNote>
            <GitBranch size={13} />
            Saved to this branch
          </DialogNote>
          <Button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!inspection || !baseBranch.trim() || !featureBranch.trim() || saving}
          >
            {saving ? <Spinner size={15} /> : <Plus size={16} />}
            {saving ? 'Creating review…' : 'Create review'}
          </Button>
        </DialogFooter>
      </form>
    </Modal>
  );
}

const styles = stylex.create({
  'modal-body': {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
  },
  'modal-introduction': {
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    color: colors.textMuted,
    marginTop: '11px',
    marginRight: '0',
    marginBottom: spacing.xxl,
    marginLeft: '0',
    maxWidth: '440px',
  },
  'review-project-context': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingBottom: spacing.xl,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderStrong,
    fontSize: typeScale.compact,
    color: colors.textEmphasis,
  },
  'saved-review-loading': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    paddingTop: '14px',
    color: colors.textSubtle,
    fontSize: typeScale.small,
  },
  'branch-fields': {
    display: 'grid',
    gridTemplateColumns: '1fr 16px 1fr',
    gap: spacing.lg,
    alignItems: 'end',
    marginTop: '3px',
  },
  'field-label': {
    display: 'block',
    fontSize: typeScale.compact,
    fontWeight: 500,
    color: colors.textDefault,
    marginTop: '18px',
    marginRight: '0',
    marginBottom: spacing.md,
    marginLeft: '0',
  },
  'branch-picker': {
    width: '100%',
  },
  'branch-fields-arrow': {
    marginBottom: '11px',
    color: colors.textMuted,
  },
  'merge-base-note': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.interactive,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: '5px',
    paddingBlock: '10px',
    paddingInline: '11px',
    marginTop: spacing.xl,
    marginRight: '0',
    marginBottom: '20px',
    marginLeft: '0',
    color: colors.textSubtle,
  },
  'working-tree-option': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    paddingTop: '21px',
  },
  newReviewIntroduction: { marginBottom: { default: 24, '@media (max-height: 780px)': 15 } },
  reviewProjectIcon: { flexShrink: 0, color: colors.textSubtle },
  reviewProjectName: { fontWeight: 550, whiteSpace: 'nowrap' },
  reviewProjectPath: {
    marginLeft: 'auto',
    color: colors.textQuiet,
    fontFamily: fonts.code,
    fontSize: typeScale.micro,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  savedReviewBranchFields: { marginTop: 10 },
  branchField: { minWidth: 0 },
  newReviewFieldLabel: { marginTop: { default: 18, '@media (max-height: 780px)': 14 } },
  codeTrigger: { fontFamily: fonts.code },
  mergeBaseIcon: { flexShrink: 0, marginTop: 1 },
  mergeBaseDescription: {
    margin: 0,
    fontSize: typeScale.caption,
    lineHeight: 1.75,
    color: colors.textSubtle,
  },
  optionalLabel: {
    display: 'inline',
    marginTop: spacing.xs,
    marginLeft: 5,
    fontSize: typeScale.caption,
    fontWeight: 400,
    color: colors.textQuiet,
  },
  workingTreeCheckbox: {
    accentColor: colors.accent,
    width: 14,
    height: 14,
    marginTop: spacing.xxs,
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
  },
  workingTreeContent: { display: 'flex', flexDirection: 'column', gap: 5 },
  workingTreeTitle: { fontSize: typeScale.compact, fontWeight: 500, color: colors.textDefault },
  workingTreeDescription: { fontSize: typeScale.caption, lineHeight: 1.6, color: colors.textMuted },
  formErrorRetry: {
    marginLeft: 'auto',
    borderWidth: 0,
    backgroundColor: colors.warningRaised,
    color: colors.warningStrong,
    borderRadius: radii.sm,
    fontSize: typeScale.small,
    paddingBlock: '3px',
    paddingInline: spacing.md,
  },
});
