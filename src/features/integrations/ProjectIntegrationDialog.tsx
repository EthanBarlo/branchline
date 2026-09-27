import * as stylex from '@stylexjs/stylex';
import { Check, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IntegrationState, ProjectIntegration } from '../../../shared/integrations';
import type { Project } from '../../../shared/types';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button, IconButton } from '../../ui/Button';
import { DialogFooter, DialogIntroduction } from '../../ui/Dialog';
import { TextInput } from '../../ui/Field';
import { Spinner, spinStyle } from '../../ui/Spinner';
import { IntegrationDialog } from './IntegrationDialog';
import { Problem } from './IntegrationError';
import { errorMessage as message } from '../../lib/errorMessage';

const emptyProject = (): ProjectIntegration => ({ repositories: [], updateSubmodulePointers: false });

export function ProjectIntegrationDialog({
  project,
  onClose,
  onSaved,
  onAccounts,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
  onAccounts: () => void;
}) {
  const [state, setState] = useState<IntegrationState | null>(null);
  const [value, setValue] = useState<ProjectIntegration>(emptyProject);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.reviewAPI
      .getIntegrations()
      .then((result) => {
        if (live) {
          setState(result);
          setValue(result.projects[project.id] || emptyProject());
        }
      })
      .catch((reason) => {
        if (live) setError(message(reason));
      })
      .finally(() => {
        if (live) setBusy('');
      });
    return () => {
      live = false;
    };
  }, [project.id]);
  async function discover() {
    setBusy('discover');
    setError('');
    try {
      const discovered = await window.reviewAPI.discoverRepositories(project.id);
      setValue((previous) => ({
        ...previous,
        repositories: [
          ...previous.repositories,
          ...discovered.filter(
            (item) => !previous.repositories.some((saved) => saved.relativePath === item.relativePath),
          ),
        ],
      }));
      if (!discovered.length)
        setError('No Bitbucket Cloud repositories were detected. Add a repository mapping below.');
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy('');
    }
  }
  async function save() {
    setBusy('save');
    setError('');
    try {
      await window.reviewAPI.configureProjectIntegration(project.id, value);
      onSaved();
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy('');
    }
  }
  return (
    <IntegrationDialog title={`${project.name} integrations`} onClose={onClose} busy={!!busy}>
      <div {...stylex.props(styles.body)}>
        <DialogIntroduction {...stylex.props(styles.introduction)}>
          Choose this project’s accounts and the repositories to include in connected reviews.
        </DialogIntroduction>
        <div {...stylex.props(styles.fieldPair)}>
          {(['bitbucket', 'jira'] as const).map((kind) => (
            <label key={kind} {...stylex.props(styles.fieldLabel, styles.fieldPairLabel)}>
              {kind === 'jira' ? 'Jira account' : 'Bitbucket account'}
              <select
                {...stylex.props(styles.select)}
                aria-label={`${kind === 'jira' ? 'Jira' : 'Bitbucket'} account`}
                disabled={!!busy}
                value={value[kind === 'jira' ? 'jiraConnectionId' : 'bitbucketConnectionId'] || ''}
                onChange={(event) =>
                  setValue({
                    ...value,
                    [kind === 'jira' ? 'jiraConnectionId' : 'bitbucketConnectionId']:
                      event.target.value || undefined,
                  })
                }
              >
                <option value="">Not connected</option>
                {state?.connections
                  .filter((item) => item.kind === kind)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label || item.displayName} · {item.email}
                      {item.connected === false ? ' (disconnected)' : ''}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <button type="button" {...stylex.props(styles.link)} disabled={!!busy} onClick={onAccounts}>
          <Settings2 size={12} />
          Manage connected accounts
        </button>
        <div {...stylex.props(styles.sectionHeading, styles.mappingHeading)}>
          <div>
            <h3 {...stylex.props(styles.sectionTitle)}>Bitbucket repositories</h3>
            <p {...stylex.props(styles.sectionDescription)}>
              Paths are relative to your project; use <code>.</code> for the parent.
            </p>
          </div>
          <Button type="button" disabled={!!busy} onClick={() => void discover()}>
            <RefreshCw
              size={12}
              className={`${busy === 'discover' ? 'spin ' : ''}${stylex.props(busy === 'discover' && spinStyle).className}`}
            />
            Discover
          </Button>
        </div>
        <div className="repository-mappings">
          {value.repositories.map((mapping, index) => (
            <div {...stylex.props(styles.mapping)} key={index}>
              <label {...stylex.props(styles.fieldLabel, styles.mappingLabel)}>
                Local path
                <TextInput
                  {...stylex.props(styles.mappingInput)}
                  aria-label={`Repository ${index + 1} local path`}
                  value={mapping.relativePath}
                  placeholder="."
                  disabled={!!busy}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      repositories: value.repositories.map((item, row) =>
                        row === index ? { ...item, relativePath: event.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label {...stylex.props(styles.fieldLabel, styles.mappingLabel)}>
                Workspace
                <TextInput
                  {...stylex.props(styles.mappingInput)}
                  aria-label={`Repository ${index + 1} workspace`}
                  value={mapping.workspace}
                  disabled={!!busy}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      repositories: value.repositories.map((item, row) =>
                        row === index ? { ...item, workspace: event.target.value, uuid: undefined } : item,
                      ),
                    })
                  }
                />
              </label>
              <label {...stylex.props(styles.fieldLabel, styles.mappingLabel)}>
                Repository
                <TextInput
                  {...stylex.props(styles.mappingInput)}
                  aria-label={`Repository ${index + 1} slug`}
                  value={mapping.repoSlug}
                  disabled={!!busy}
                  onChange={(event) =>
                    setValue({
                      ...value,
                      repositories: value.repositories.map((item, row) =>
                        row === index ? { ...item, repoSlug: event.target.value, uuid: undefined } : item,
                      ),
                    })
                  }
                />
              </label>
              <IconButton
                type="button"
                {...stylex.props(styles.mappingRemove)}
                disabled={!!busy}
                aria-label={`Remove repository ${index + 1}`}
                onClick={() =>
                  setValue({ ...value, repositories: value.repositories.filter((_, row) => row !== index) })
                }
              >
                <X size={13} />
              </IconButton>
              {mapping.relativePath && mapping.relativePath !== '.' && (
                <div {...stylex.props(styles.mappingHierarchy)}>
                  <label {...stylex.props(styles.fieldLabel, styles.hierarchyLabel)}>
                    Parent local path
                    <TextInput
                      {...stylex.props(styles.mappingInput)}
                      aria-label={`Repository ${index + 1} parent path`}
                      placeholder="."
                      value={mapping.parentRelativePath || ''}
                      disabled={!!busy}
                      onChange={(event) =>
                        setValue({
                          ...value,
                          repositories: value.repositories.map((item, row) =>
                            row === index
                              ? { ...item, parentRelativePath: event.target.value || undefined }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label {...stylex.props(styles.fieldLabel, styles.hierarchyLabel)}>
                    Submodule path in parent
                    <TextInput
                      {...stylex.props(styles.mappingInput)}
                      aria-label={`Repository ${index + 1} submodule path`}
                      placeholder={mapping.relativePath}
                      value={mapping.submodulePath || ''}
                      disabled={!!busy}
                      onChange={(event) =>
                        setValue({
                          ...value,
                          repositories: value.repositories.map((item, row) =>
                            row === index
                              ? { ...item, submodulePath: event.target.value || undefined }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
        <button
          {...stylex.props(styles.link)}
          type="button"
          disabled={!!busy}
          onClick={() =>
            setValue({
              ...value,
              repositories: [...value.repositories, { relativePath: '', workspace: '', repoSlug: '' }],
            })
          }
        >
          <Plus size={12} />
          Add repository mapping
        </button>
        <label {...stylex.props(styles.fieldLabel, styles.checkbox, styles.pointerSetting)}>
          <input
            {...stylex.props(styles.checkboxInput)}
            type="checkbox"
            disabled={!!busy}
            checked={value.updateSubmodulePointers}
            onChange={(event) => setValue({ ...value, updateSubmodulePointers: event.target.checked })}
          />
          <span {...stylex.props(styles.checkboxContent)}>
            <strong {...stylex.props(styles.checkboxTitle)}>Update submodule pointers when merging</strong>
            <small {...stylex.props(styles.checkboxDescription)}>
              Merge children first, then review the pointer update before merging the parent.
            </small>
          </span>
        </label>
        {error && <Problem>{error}</Problem>}
      </div>
      <DialogFooter {...stylex.props(styles.modalChrome)}>
        <Button disabled={!!busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!!busy || !state} onClick={() => void save()}>
          {busy === 'save' ? <Spinner size={13} /> : <Check size={13} />}Save integrations
        </Button>
      </DialogFooter>
    </IntegrationDialog>
  );
}

const styles = stylex.create({
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: '0',
    overflow: 'auto',
  },
  introduction: { maxWidth: '570px', marginBottom: '20px' },
  fieldPair: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: spacing.lg,
    marginBottom: '13px',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '7px',
    color: colors.textEmphasis,
    fontSize: typeScale.small,
  },
  fieldPairLabel: { minWidth: '0' },
  select: {
    width: '100%',
    minHeight: '34px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: radii.md,
    paddingBlock: spacing.sm,
    paddingInline: '9px',
    backgroundColor: colors.panel,
    color: colors.textDefault,
    fontSize: typeScale.compact,
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '0',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover': colors.textPrimary },
    textDecoration: { default: 'none', ':hover': 'underline' },
    opacity: { default: 1, ':disabled': 0.4 },
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
  },
  sectionHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  mappingHeading: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    marginTop: '20px',
    marginRight: '0',
    marginBottom: '13px',
    marginLeft: '0',
    paddingTop: '19px',
  },
  sectionTitle: { margin: '0', fontSize: typeScale.body, fontWeight: 550 },
  sectionDescription: {
    marginTop: '5px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.7,
  },
  mapping: {
    display: 'grid',
    gridTemplateColumns: '.85fr 1fr 1fr 24px',
    alignItems: 'end',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  mappingLabel: { minWidth: '0', fontSize: typeScale.caption },
  mappingInput: { height: 33, fontSize: typeScale.compact },
  mappingRemove: { height: '33px' },
  mappingHierarchy: {
    gridColumnEnd: '-1',
    gridColumnStart: '1',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '9px',
    paddingTop: '0',
    paddingRight: '32px',
    paddingBottom: '9px',
    paddingLeft: '0',
  },
  hierarchyLabel: { color: colors.textQuiet, fontSize: typeScale.caption },
  checkbox: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: '9px',
  },
  pointerSetting: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    paddingTop: '17px',
    marginTop: '23px',
  },
  checkboxInput: { accentColor: colors.accent, marginTop: spacing.xxs, flexShrink: '0' },
  checkboxContent: { display: 'flex', flexDirection: 'column', gap: '5px' },
  checkboxTitle: { fontSize: typeScale.compact, fontWeight: 500 },
  checkboxDescription: { fontSize: typeScale.small, color: colors.textQuiet, lineHeight: 1.6 },
  modalChrome: { flexShrink: '0' },
});
