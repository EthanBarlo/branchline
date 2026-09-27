import type { DiffLineAnnotation, FileDiffOptions } from '@pierre/diffs';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReviewFile } from '../../../../shared/types';
import type { CommentAutosave } from './commentAutosave';
import { placeComments, type CommentPlacement, type PlacementSnapshot } from './commentPlacement';
export type Annotation = { session: CommentAutosave; placement: CommentPlacement; outdated: boolean };

export function useDiffAnnotations(file: ReviewFile, allSessions: CommentAutosave[]) {
  const placementSnapshot = useRef<PlacementSnapshot | undefined>(undefined);
  const placements = useMemo(() => {
    const next = placeComments(allSessions, file, placementSnapshot.current);
    placementSnapshot.current = next;
    return next.positions;
  }, [allSessions, file]);
  const hasTextDiff =
    !file.unavailable &&
    !file.binary &&
    !file.tooLarge &&
    (file.oldContent ?? '') !== (file.newContent ?? '');
  const annotations = useMemo<DiffLineAnnotation<Annotation>[]>(
    () =>
      hasTextDiff
        ? allSessions.flatMap((session) => {
            const placement = placements.get(session.id);
            return placement
              ? [
                  {
                    lineNumber: placement.lineEnd,
                    side: placement.side,
                    metadata: {
                      session,
                      placement,
                      outdated: session.anchor.fingerprint !== file.fingerprint,
                    },
                  },
                ]
              : [];
          })
        : [],
    [allSessions, placements, file.fingerprint, hasTextDiff],
  );
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<string>>(() => new Set());
  const trackVisibleComments = useCallback<
    NonNullable<FileDiffOptions<Annotation, undefined>['onPostRender']>
  >((node, instance, phase) => {
    if (phase === 'unmount' || !node.shadowRoot) return;
    // Use the renderer's actual slots so old-side comments and manually expanded
    // context stay accurate without changing either the diff or saved anchors.
    const slots = new Set(
      [...node.shadowRoot.querySelectorAll('slot[name]')].map((slot) => slot.getAttribute('name')),
    );
    const hidden = new Set(
      annotationsRef.current
        .filter((annotation) => !slots.has(instance.getAnnotationSlotName(annotation)))
        .map((annotation) => annotation.metadata.session.id),
    );
    setCollapsedCommentIds((previous) =>
      previous.size === hidden.size && [...hidden].every((id) => previous.has(id)) ? previous : hidden,
    );
  }, []);
  const collapsedComments = annotations.filter((annotation) =>
    collapsedCommentIds.has(annotation.metadata.session.id),
  );
  const topComments = allSessions.filter((session) => !hasTextDiff || !placements.get(session.id));

  return {
    hasTextDiff,
    annotations,
    collapsedComments,
    collapsedCommentIds,
    topComments,
    trackVisibleComments,
  };
}
