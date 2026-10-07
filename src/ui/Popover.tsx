import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { colors, radii } from '../theme/tokens.stylex';

const OPEN_DELAY = 120;
const CLOSE_DELAY = 150;
const GAP = 6;
const MARGIN = 8;

const popIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateY(-3px) scale(.98)' },
  to: { opacity: 1, transform: 'none' },
});

export type PopoverTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  'aria-expanded': boolean;
  'aria-haspopup': 'dialog';
  'aria-controls': string | undefined;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

/**
 * A small non-modal popover that opens on hover, focus or click. Hovering
 * previews it; clicking pins it open until Escape or an outside click.
 */
export function Popover({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const suppressFocusOpen = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const cancel = () => window.clearTimeout(timer.current);
  const schedule = (next: boolean, delay: number) => {
    cancel();
    timer.current = window.setTimeout(() => {
      if (!next) pinned.current = false;
      setOpen(next);
    }, delay);
  };
  const close = useCallback((restoreFocus = false) => {
    window.clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
    if (restoreFocus) {
      suppressFocusOpen.current = true;
      anchor.current?.focus();
      suppressFocusOpen.current = false;
    }
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const place = useCallback(() => {
    const target = anchor.current;
    const element = panel.current;
    if (!target || !element) return;
    if (!target.isConnected) return close();
    const rect = target.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight - MARGIN ? rect.top - GAP - height : below;
    setPosition({
      left: Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, top),
    });
  }, [close]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const clickAway = (event: PointerEvent) => {
      const path = event.composedPath();
      if (anchor.current && path.includes(anchor.current)) return;
      if (panel.current && path.includes(panel.current)) return;
      close();
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    document.addEventListener('pointerdown', clickAway, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('pointerdown', clickAway, true);
    };
  }, [open, place, close]);

  const within = (node: EventTarget | null) =>
    node instanceof Node && Boolean(anchor.current?.contains(node) || panel.current?.contains(node));
  const focusables = () => [
    ...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]') ?? []),
  ];

  return (
    <>
      {trigger({
        ref: anchor,
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-controls': open ? id : undefined,
        onPointerEnter: () => schedule(true, OPEN_DELAY),
        onPointerLeave: () => {
          if (!pinned.current) schedule(false, CLOSE_DELAY);
          else cancel();
        },
        onFocus: () => {
          if (suppressFocusOpen.current) return;
          cancel();
          setOpen(true);
        },
        onBlur: (event) => {
          if (!within(event.relatedTarget)) close();
        },
        onClick: () => {
          cancel();
          if (open && pinned.current) return close();
          pinned.current = true;
          setOpen(true);
        },
        onKeyDown: (event) => {
          if (!open) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (event.key === 'Tab' && !event.shiftKey) {
            // The panel is portalled, so move focus into it explicitly.
            const first = focusables()[0];
            if (!first) return;
            event.preventDefault();
            first.focus();
          }
        },
      })}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={label}
            // Focusable so clicks on text inside keep focus within the popover.
            tabIndex={-1}
            className={`popover ${stylex.props(styles.popover).className}`}
            style={
              {
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                visibility: position ? 'visible' : 'hidden',
                WebkitAppRegion: 'no-drag',
              } as CSSProperties
            }
            onPointerEnter={cancel}
            onPointerLeave={() => {
              if (!pinned.current) schedule(false, CLOSE_DELAY);
            }}
            onBlur={(event) => {
              if (!within(event.relatedTarget)) close();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
              }
              if (event.key !== 'Tab') return;
              const items = focusables();
              const index = items.indexOf(document.activeElement as HTMLElement);
              if (event.shiftKey && index <= 0) {
                event.preventDefault();
                close(true);
              } else if (!event.shiftKey && index === items.length - 1) {
                event.preventDefault();
                close(true);
              }
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

const styles = stylex.create({
  popover: {
    position: 'fixed',
    zIndex: 205,
    boxSizing: 'border-box',
    width: 'max-content',
    minWidth: 240,
    maxWidth: 'min(380px, calc(100vw - 16px))',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: `0 12px 32px ${colors.shadowMedium}, 0 1px 3px ${colors.shadowSoft}`,
    color: colors.textPrimary,
    transformOrigin: 'top right',
    animationName: popIn,
    animationDuration: '120ms',
    animationTimingFunction: 'ease-out',
    outline: 'none',
  },
});
