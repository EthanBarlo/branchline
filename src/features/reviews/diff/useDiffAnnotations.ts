import type { DiffLineAnnotation, FileDiffMetadata, FileDiffOptions } from '@pierre/diffs';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReviewFile } from '../../../../shared/types';
import type { CommentAutosave } from './commentAutosave';
import { placeComments, type CommentPlacement, type PlacementSnapshot } from './commentPlacement';
export type Annotation = { session: CommentAutosave; placement: CommentPlacement; outdated: boolean };

export function useDiffAnnotations(
  file: ReviewFile,
  allSessions: CommentAutosave[],
  diff?: FileDiffMetadata,
) {
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
  const diffRef = useRef(diff);
  diffRef.current = diff;
  const seen = useRef({ fingerprint: file.fingerprint, ids: new Set<string>() });
  if (seen.current.fingerprint !== file.fingerprint)
    seen.current = { fingerprint: file.fingerprint, ids: new Set() };
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<string>>(() => new Set());
  const trackVisibleComments = useCallback<
    NonNullable<FileDiffOptions<Annotation, undefined>['onPostRender']>
  >((node, instance, phase) => {
    if (phase === 'unmount' || !node.shadowRoot) return;
    if (!annotationsRef.current.length) {
      setCollapsedCommentIds((previous) => (previous.size ? new Set() : previous));
      return;
    }
    // Use the renderer's actual slots so old-side comments and manually expanded
    // context stay accurate without changing either the diff or saved anchors.
    const slots = new Set(
      [...node.shadowRoot.querySelectorAll('slot[name]')].map((slot) => slot.getAttribute('name')),
    );
    const indexes = [...node.shadowRoot.querySelectorAll('[data-line-index]')]
      .map((line) => Number(line.getAttribute('data-line-index')?.split(',')[0]))
      .filter(Number.isFinite);
    const buffered = !!node.shadowRoot.querySelector('[data-buffer-size]');
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    setCollapsedCommentIds((previous) => {
      const hidden = new Set<string>();
      for (const annotation of annotationsRef.current) {
        const id = annotation.metadata.session.id;
        if (slots.has(instance.getAnnotationSlotName(annotation))) {
          seen.current.ids.add(id);
          continue;
        }
        const inHunk = diffRef.current?.hunks.some((hunk) => {
          const start = annotation.side === 'deletions' ? hunk.deletionStart : hunk.additionStart;
          const count = annotation.side === 'deletions' ? hunk.deletionCount : hunk.additionCount;
          return annotation.lineNumber >= start && annotation.lineNumber < start + count;
        });
        // Saved feedback in an unchanged gap is recoverable even when that gap
        // is outside the virtual window. Previously revealed rows retain their
        // observed expansion state until they render again.
        if (diffRef.current && !inHunk && !seen.current.ids.has(id)) {
          hidden.add(id);
          continue;
        }
        const index = instance.getLineIndex(annotation.lineNumber, annotation.side)?.[0];
        // A virtual row outside the rendered window is not collapsed context.
        // Retain its last known context state until this part of the file renders.
        if (!indexes.length || (buffered && index !== undefined && (index < first || index > last))) {
          if (previous.has(id)) hidden.add(id);
        } else hidden.add(id);
      }
      return previous.size === hidden.size && [...hidden].every((id) => previous.has(id)) ? previous : hidden;
    });
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
