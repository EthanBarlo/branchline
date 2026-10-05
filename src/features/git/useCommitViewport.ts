import { useLayoutEffect, useRef, useState } from 'react';

/** Keep only visible commit rows and a small overscan buffer mounted. */
export function useCommitViewport(count: number, rowHeight: number, scope: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ scrollTop: 0, height: 600 });
  const [nearEnd, setNearEnd] = useState(false);
  useLayoutEffect(() => {
    const element = viewport.current;
    const end = sentinel.current;
    if (!element || !end) return;
    element.scrollTop = 0;
    setNearEnd(false);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = { scrollTop: Math.max(0, element.scrollTop - 28), height: element.clientHeight };
      setGeometry((previous) =>
        previous.scrollTop === next.scrollTop && previous.height === next.height ? previous : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const intersection = new IntersectionObserver(
      (entries) => setNearEnd(entries.some((entry) => entry.isIntersecting)),
      { root: element, rootMargin: '600px 0px' },
    );
    measure();
    element.addEventListener('scroll', schedule, { passive: true });
    resize.observe(element);
    intersection.observe(end);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', schedule);
      resize.disconnect();
      intersection.disconnect();
    };
  }, [scope]);
  const visible = Math.floor(geometry.scrollTop / rowHeight);
  const first = Math.max(0, Math.min(Math.max(0, count - 1), visible - 8));
  const last = Math.min(count, Math.max(first, visible) + Math.ceil(geometry.height / rowHeight) + 8);
  return { viewport, sentinel, first, last, height: geometry.height, nearEnd };
}
