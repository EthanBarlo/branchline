import * as stylex from '@stylexjs/stylex';
import { FolderGit2, Plus, Settings2 } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { UpdateState } from '../../../shared/updates';
import { colors, radii, spacing, typeScale } from '../../tokens.stylex';
import { IconButton } from '../../ui/Button';
import { UpdateButton } from '../settings/UpdateControls';

const styles = stylex.create({
  chrome: {
    height: 40,
    minHeight: 40,
    display: 'flex',
    alignItems: 'stretch',
    paddingTop: 0,
    paddingRight: 10,
    paddingBottom: 0,
    paddingLeft: 84,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.panel,
    position: 'relative',
    userSelect: 'none',
  },
  tabs: {
    display: 'flex',
    alignItems: 'stretch',
    flex: '1',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    '::-webkit-scrollbar': { height: 2 },
  },
  tab: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    minWidth: { default: 126, '@media (max-width: 1050px)': 110 },
    maxWidth: { default: 228, '@media (max-width: 1050px)': 195 },
    flexShrink: 0,
    paddingBlock: 0,
    paddingInline: { default: 16, '@media (max-width: 1050px)': 12 },
    borderWidth: 0,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    backgroundColor: { default: 'transparent', ':hover': colors.raised },
    color: { default: colors.textMuted, ':hover': colors.textDefault },
    fontSize: typeScale.compact,
    outlineOffset: { default: null, ':focus-visible': -4 },
  },
  activeTab: {
    backgroundColor: colors.raised,
    color: colors.textPrimary,
    '::after': {
      content: "''",
      position: 'absolute',
      height: 2,
      left: 14,
      right: 14,
      bottom: 0,
      backgroundColor: colors.textEmphasis,
    },
  },
  tabIcon: { flexShrink: 0, color: colors.textQuiet },
  selectedTabIcon: { color: colors.textSecondary },
  tabName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  addTab: {
    display: 'inline-flex',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 26,
    marginBlock: 0,
    marginInline: spacing.md,
    padding: 0,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.interactive },
    color: { default: colors.textMuted, ':hover': colors.textDefault },
    borderRadius: radii.md,
    flexShrink: 0,
  },
  settingsLabel: {
    display: 'flex',
    alignItems: 'center',
    flex: '1',
    gap: spacing.md,
    paddingLeft: 13,
    color: colors.textTertiary,
    fontSize: typeScale.compact,
  },
  appName: {
    display: { default: 'inline-flex', '@media (max-width: 1050px)': 'none' },
    alignItems: 'center',
    gap: 5,
    paddingLeft: 9,
    paddingRight: 3,
    fontSize: typeScale.compact,
    fontWeight: 550,
    letterSpacing: '-.3px',
    color: colors.textFaint,
  },
  appNameDot: { color: colors.textMuted },
  settingsButton: { alignSelf: 'center', width: 28, height: 28, marginLeft: 10, flexShrink: 0 },
});

interface AppChromeProps {
  projects: Project[];
  selectedProjectId: string | null;
  showSettings: boolean;
  initializing: boolean;
  updateState: UpdateState | null;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onShowUpdates: () => void;
  onOpenSettings: () => void;
}

export function AppChrome({
  projects,
  selectedProjectId,
  showSettings,
  initializing,
  updateState,
  onSelectProject,
  onAddProject,
  onShowUpdates,
  onOpenSettings,
}: AppChromeProps) {
  return (
    <div className={`project-tab-strip window-chrome ${stylex.props(styles.chrome).className}`}>
      {showSettings ? (
        <div className={`settings-chrome-label ${stylex.props(styles.settingsLabel).className}`}>
          <Settings2 size={13} />
          Settings
        </div>
      ) : (
        <div
          className={`project-tabs ${stylex.props(styles.tabs).className}`}
          role="tablist"
          aria-label="Projects"
        >
          {projects.map((project, index) => {
            const selected = selectedProjectId === project.id;
            return (
              <button
                key={project.id}
                id={`project-tab-${project.id}`}
                className={`project-tab ${selected ? 'active' : ''} ${stylex.props(styles.tab, selected && styles.activeTab).className}`}
                role="tab"
                aria-label={project.name}
                aria-selected={selected}
                aria-controls="project-workspace"
                tabIndex={selected ? 0 : -1}
                title={project.repoPath}
                onClick={() => onSelectProject(project.id)}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % projects.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + projects.length) % projects.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? projects.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelectProject(projects[next].id);
                  document.getElementById(`project-tab-${projects[next].id}`)?.focus();
                }}
              >
                <FolderGit2
                  size={13}
                  className={stylex.props(styles.tabIcon, selected && styles.selectedTabIcon).className}
                />
                <span {...stylex.props(styles.tabName)}>{project.name}</span>
              </button>
            );
          })}
          <button
            className={`add-project-tab ${stylex.props(styles.addTab).className}`}
            aria-label="Add project"
            title="Add project"
            onClick={onAddProject}
          >
            <Plus size={15} />
          </button>
        </div>
      )}
      <UpdateButton state={updateState} onClick={onShowUpdates} />
      <span className={`chrome-app-name ${stylex.props(styles.appName).className}`}>
        branchline<span {...stylex.props(styles.appNameDot)}>.</span>
      </span>
      <IconButton
        className={`app-settings-button ${stylex.props(styles.settingsButton).className}`}
        aria-label="App settings"
        title="Settings"
        aria-pressed={showSettings}
        disabled={showSettings || initializing || !window.reviewAPI}
        onClick={onOpenSettings}
      >
        <Settings2 size={15} />
      </IconButton>
    </div>
  );
}
