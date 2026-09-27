import * as stylex from '@stylexjs/stylex';
import { Trash2 } from 'lucide-react';
import type { Project, Review } from '../../../shared/types';
import { colors, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog, DialogFooter } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';

type Target = { project: Project; reviewCount: number } | { review: Review };

export function ConfirmDeletionDialog({
  target,
  removing,
  onClose,
  onConfirm,
}: {
  target: Target;
  removing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const project = 'project' in target;
  return (
    <Dialog
      title={project ? 'Remove this project?' : 'Delete this review?'}
      onClose={() => {
        if (!removing) onClose();
      }}
      small
    >
      <div className={`confirm-copy ${stylex.props(styles.copy).className}`}>
        <p>
          <strong {...stylex.props(styles.strong)}>
            {project ? target.project.name : target.review.name}
          </strong>
          {project
            ? ` will be removed from Branchline, along with its ${target.reviewCount} saved reviews, their comments, and all Current feedback and review progress.`
            : ' and its saved comments and review progress will be removed.'}
        </p>
        <p {...stylex.props(styles.lastParagraph)}>
          {project
            ? 'Your repository and local files will remain untouched.'
            : 'The repository and your code remain on disk.'}
        </p>
      </div>
      <DialogFooter>
        <Button disabled={removing} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={removing} onClick={onConfirm}>
          {removing ? <Spinner size={15} /> : <Trash2 size={15} />}
          {project ? 'Remove project' : 'Delete review'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const styles = stylex.create({
  copy: {
    color: colors.textEmphasis,
    fontSize: typeScale.body,
    lineHeight: 1.8,
    paddingTop: '13px',
    paddingRight: '27px',
    paddingBottom: spacing.xl,
    paddingLeft: '27px',
  },
  strong: { color: colors.textDefault, fontWeight: 550 },
  lastParagraph: { color: colors.textMuted, fontSize: typeScale.small },
});
