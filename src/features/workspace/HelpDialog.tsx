import * as stylex from '@stylexjs/stylex';
import {
  Check,
  CircleCheck,
  Clipboard,
  FolderGit2,
  GitCompareArrows,
  GitFork,
  RefreshCw,
} from 'lucide-react';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog as Modal } from '../../ui/Dialog';

const styles = stylex.create({
  'modal-body': {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
  },
  'help-content': {
    paddingTop: '26px',
  },
  'modal-footer': {
    paddingBlock: '17px',
    paddingInline: '27px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderStrong,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '9px',
    backgroundColor: colors.surface,
  },
  helpRow: { display: 'flex', gap: 15, marginBottom: 20 },
  helpIcon: { flexShrink: 0, color: colors.textSecondary, marginTop: spacing.xxs },
  helpTitle: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: spacing.sm,
    marginLeft: '0',
    color: colors.textDefault,
    fontSize: typeScale.body,
    fontWeight: 500,
  },
  helpDescription: { margin: 0, color: colors.textSubtle, fontSize: typeScale.compact, lineHeight: 1.8 },
  lastHelpRow: { marginBottom: 0 },
});

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Review at the speed of work." onClose={onClose}>
      <div
        className={`modal-body help-content ${stylex.props(styles['modal-body'], styles['help-content']).className}`}
      >
        <div {...stylex.props(styles.helpRow)}>
          <FolderGit2 size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>Give each repository a home</h3>
            <p {...stylex.props(styles.helpDescription)}>
              Add a project once, then switch between projects in the tabs. Current follows the branch checked
              out in your project. Choose its target once, then review as you work. Use Review another branch
              for a separate review that stays attached to a specific branch.
            </p>
          </section>
        </div>
        <div {...stylex.props(styles.helpRow)}>
          <GitCompareArrows size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>See your feature’s changes</h3>
            <p {...stylex.props(styles.helpDescription)}>
              Branchline compares the feature branch to its merge base with the target. Changes made only on
              the target stay out of your review.
            </p>
          </section>
        </div>
        <div {...stylex.props(styles.helpRow)}>
          <GitFork size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>Bring every submodule along</h3>
            <p {...stylex.props(styles.helpDescription)}>
              The same branch names are compared inside each initialized submodule, even when the parent
              hasn’t committed new submodule pointers. Missing branches appear as notices.
            </p>
          </section>
        </div>
        <div {...stylex.props(styles.helpRow)}>
          <RefreshCw size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>Keep pace with your agent</h3>
            <p {...stylex.props(styles.helpDescription)}>
              Changes refresh every four seconds while the window is visible. Uncommitted edits and new files
              are included when that repository is checked out on your feature branch.
            </p>
          </section>
        </div>
        <div {...stylex.props(styles.helpRow)}>
          <CircleCheck size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>Review a file with confidence</h3>
            <p {...stylex.props(styles.helpDescription)}>
              Mark a file reviewed when it looks good and the next unreviewed file opens automatically. If its
              content changes, that approval becomes out of date so the file returns to your unreviewed list.
            </p>
          </section>
        </div>
        <div {...stylex.props(styles.helpRow, styles.lastHelpRow)}>
          <Clipboard size={20} className={stylex.props(styles.helpIcon).className} />
          <section>
            <h3 {...stylex.props(styles.helpTitle)}>Give all your feedback at once</h3>
            <p {...stylex.props(styles.helpDescription)}>
              Click a line number to comment. Feedback saves as you type; click away to finish editing. Copy
              feedback groups unresolved comments by file, with just their paths and line references. Comments
              on an earlier revision are kept for reference.
            </p>
          </section>
        </div>
      </div>
      <div className={`modal-footer ${stylex.props(styles['modal-footer']).className}`}>
        <Button variant="primary" onClick={onClose}>
          Got it
          <Check size={15} />
        </Button>
      </div>
    </Modal>
  );
}
