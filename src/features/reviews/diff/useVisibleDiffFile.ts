import { useEffect, useRef, type RefObject } from 'react';

export function useVisibleDiffFile(
  root: RefObject<HTMLDivElement | null>,
  fileIds: readonly string[],
  onVisibleFileChange: (fileId: string) => void,
) {
  const latestCallback = useRef(onVisibleFileChange);
  latestCallback.current = onVisibleFileChange;

  useEffect(() => {
    const scroller = root.current?.querySelector<HTMLElement>('.review-diff-stack');
    if (!scroller) return;
    const sections = [...scroller.querySelectorAll<HTMLElement>('.review-diff-accordion')];
    let frame = 0;
    let lastFileId: string | undefined;

    function update() {
      frame = 0;
      if (!scroller || !scroller.clientHeight) return;
      const viewport = scroller.getBoundingClientRect();
      // Section bounds include sticky headers and virtualized/offscreen bodies.
      // Find the first section still crossing the top of the viewport, even
      // halfway through a diff whose original header is far above it.
      let low = 0;
      let high = sections.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sections[middle].getBoundingClientRect().bottom <= viewport.top + 1) low = middle + 1;
        else high = middle;
      }
      const section = sections[low];
      if (!section || section.getBoundingClientRect().top >= viewport.bottom) return;
      const fileId = section.dataset.fileId;
      if (fileId && fileId !== lastFileId) {
        lastFileId = fileId;
        latestCallback.current(fileId);
      }
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [root, fileIds]);
}
