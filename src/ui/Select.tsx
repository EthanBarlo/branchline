import * as stylex from '@stylexjs/stylex';
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { colors, fonts, radii, spacing, typeScale } from '../tokens.stylex';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  control: {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '100%',
    verticalAlign: 'middle',
    WebkitAppRegion: 'no-drag',
  },
  fieldControl: { display: 'flex', width: '100%' },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
    minWidth: 0,
    height: 27,
    paddingBlock: 0,
    paddingInline: spacing.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: radii.md,
    fontFamily: fonts.body,
    fontSize: typeScale.compact,
    textAlign: 'left',
    cursor: 'pointer',
    WebkitAppRegion: 'no-drag',
    borderColor: { default: colors.hover, ':hover:not(:disabled)': colors.borderSelected },
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.interactive },
    color: { default: colors.textSecondary, ':hover:not(:disabled)': colors.textPrimary },
    outline: { default: null, ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: null, ':focus-visible': 2 },
  },
  openTrigger: {
    borderColor: { default: colors.textQuiet, ':hover:not(:disabled)': colors.textQuiet },
    backgroundColor: { default: colors.interactive, ':hover:not(:disabled)': colors.interactive },
  },
  disabledTrigger: { opacity: 0.45, cursor: 'default' },
  placeholder: { color: colors.textMuted },
  fieldTrigger: {
    height: 37,
    paddingBlock: '0',
    paddingInline: '10px',
    fontSize: typeScale.body,
    backgroundColor: { default: colors.surface, ':hover:not(:disabled)': colors.raised },
    borderColor: { default: colors.highlight, ':hover:not(:disabled)': colors.textFaint },
  },
  openFieldTrigger: {
    borderColor: { default: null, ':hover:not(:disabled)': colors.textFaint },
    backgroundColor: { default: null, ':hover:not(:disabled)': colors.raised },
  },
  quietTrigger: {
    height: 24,
    paddingBlock: '0',
    paddingInline: '4px',
    borderColor: 'transparent',
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.interactive },
    color: { default: colors.textEmphasis, ':hover:not(:disabled)': colors.textDefault },
  },
  openQuietTrigger: {
    backgroundColor: { default: colors.interactive, ':hover:not(:disabled)': colors.interactive },
    borderColor: { default: colors.borderSelected, ':hover:not(:disabled)': colors.borderSelected },
  },
  value: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  triggerIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: colors.textSubtle,
  },
  triggerIconSvg: { width: 14, height: 14 },
  chevron: { flexShrink: 0, color: colors.textMuted },
  openChevron: { transform: 'rotate(180deg)' },
  spinner: {
    animationName: spin,
    animationDuration: { default: '1.1s', '@media (prefers-reduced-motion: reduce)': '3s' },
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  popup: {
    position: 'fixed',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    padding: spacing.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    color: colors.textDefault,
    boxShadow: `0 8px 28px ${colors.shadow}, 0 1px 0 ${colors.insetHighlight} inset`,
    zIndex: 200,
    overflow: 'hidden',
    WebkitAppRegion: 'no-drag',
    fontFamily: fonts.body,
    fontSize: typeScale.compact,
    textAlign: 'left',
  },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    height: 38,
    minHeight: 38,
    paddingBlock: '0',
    paddingInline: spacing.md,
    marginBottom: spacing.xs,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.hover,
    color: colors.textMuted,
  },
  searchIcon: { flexShrink: 0 },
  searchInput: {
    width: '100%',
    minWidth: 0,
    height: '100%',
    padding: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: 'transparent',
    color: colors.textPrimary,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    outline: 'none',
    WebkitAppRegion: 'no-drag',
    '::placeholder': { color: colors.textQuiet },
  },
  options: {
    flex: '1',
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    scrollPadding: 3,
    outline: 'none',
    scrollbarWidth: 'thin',
    '::-webkit-scrollbar': { width: 6 },
    '::-webkit-scrollbar-thumb': {
      backgroundColor: colors.borderSelected,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: colors.surface,
      borderRadius: radii.md,
    },
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    minWidth: 0,
    height: 32,
    paddingBlock: '0',
    paddingInline: '9px',
    borderRadius: radii.sm,
    color: colors.textSecondary,
    cursor: 'pointer',
    userSelect: 'none',
  },
  highlightedOption: { backgroundColor: colors.hover, color: colors.textPrimary },
  selectedOption: { color: colors.textDefault },
  optionLabel: {
    flex: '1',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: typeScale.compact,
  },
  optionDescription: {
    maxWidth: '43%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.textMuted,
    fontSize: typeScale.small,
  },
  highlightedDescription: { color: colors.textEmphasis },
  optionCheck: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 13,
    flexShrink: 0,
    color: colors.textDefault,
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    height: 24,
    paddingBlock: '0',
    paddingInline: '9px',
    color: colors.textQuiet,
    fontSize: typeScale.caption,
    fontWeight: 550,
    letterSpacing: '.45px',
  },
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    padding: spacing.lg,
    color: colors.textMuted,
    fontSize: typeScale.compact,
  },
});

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

interface SelectProps {
  id?: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  style?: stylex.StyleXStyles;
  triggerStyle?: stylex.StyleXStyles;
  icon?: ReactNode;
  title?: string;
  variant?: 'compact' | 'field' | 'quiet';
}

interface PopupPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function matches(option: SelectOption, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return (
    !needle ||
    [option.label, option.value, option.description || ''].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    )
  );
}

export function Select({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  searchable = true,
  searchPlaceholder = 'Search…',
  disabled = false,
  loading = false,
  className = '',
  style,
  triggerStyle: triggerOverride,
  icon,
  title,
  variant = 'compact',
}: SelectProps) {
  const generatedId = useId();
  const triggerId = id || `select-${generatedId}`;
  const listId = `${triggerId}-options`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(-1);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listbox = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const visibleOptions = useMemo(() => options.filter((option) => matches(option, query)), [options, query]);
  const optionId = (index: number) => `${listId}-${index}`;
  const activeId =
    open && highlighted >= 0 && highlighted < visibleOptions.length ? optionId(highlighted) : undefined;

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function show(initial?: 'first' | 'last') {
    if (disabled || loading) return;
    setQuery('');
    setPosition(null);
    setPortalTarget(trigger.current?.closest<HTMLElement>('.modal') || document.body);
    const selectedIndex = options.findIndex((option) => option.value === value);
    setHighlighted(
      initial === 'first' ? 0 : initial === 'last' ? options.length - 1 : Math.max(0, selectedIndex),
    );
    setOpen(true);
  }

  function choose(option: SelectOption) {
    close(true);
    onChange(option.value);
  }

  function tabToAdjacentControl(backwards: boolean) {
    const currentTrigger = trigger.current;
    if (!currentTrigger) return;
    const modal = currentTrigger.closest<HTMLElement>('.modal');
    const scope = modal || document.body;
    const controls = Array.from(
      scope.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
      ),
    ).filter(
      (element) =>
        element.offsetParent !== null &&
        !popup.current?.contains(element) &&
        element.getAttribute('aria-hidden') !== 'true',
    );
    const index = controls.indexOf(currentTrigger);
    let nextIndex = index + (backwards ? -1 : 1);
    if (modal && controls.length) nextIndex = (nextIndex + controls.length) % controls.length;
    close(false);
    const next = controls[nextIndex];
    if (next) next.focus({ preventScroll: true });
    else currentTrigger.focus({ preventScroll: true });
  }

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        show(
          event.key === 'Home'
            ? 'first'
            : event.key === 'End' || event.key === 'ArrowUp'
              ? 'last'
              : undefined,
        );
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      tabToAdjacentControl(event.shiftKey);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setHighlighted((previous) =>
        visibleOptions.length
          ? (previous + (event.key === 'ArrowDown' ? 1 : -1) + visibleOptions.length) % visibleOptions.length
          : -1,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      setHighlighted(event.key === 'Home' ? 0 : visibleOptions.length - 1);
    } else if (event.key === 'Enter' || (!searchable && event.key === ' ')) {
      event.preventDefault();
      event.stopPropagation();
      const option = visibleOptions[highlighted];
      if (option) choose(option);
    }
  }

  useLayoutEffect(() => {
    if (!open || !portalTarget) return;
    function place() {
      if (!trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight;
      const margin = 8;
      const gap = 5;
      const width = Math.min(Math.max(rect.width, searchable ? 280 : 150), viewportWidth - margin * 2);
      let groupCount = 0;
      let lastGroup: string | undefined;
      for (const option of visibleOptions) {
        if (option.group && option.group !== lastGroup) groupCount++;
        lastGroup = option.group;
      }
      const desiredHeight = Math.min(
        326,
        8 +
          (searchable ? 42 : 0) +
          (visibleOptions.length ? visibleOptions.length * 32 + groupCount * 24 : 56),
      );
      const below = viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const flip = below < Math.min(desiredHeight, 180) && above > below;
      const maxHeight = Math.max(40, Math.min(desiredHeight, flip ? above : below));
      setPosition({
        top: flip ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap,
        left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
        width,
        maxHeight,
      });
    }
    place();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      observer.disconnect();
    };
  }, [open, portalTarget, searchable, visibleOptions]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    if (searchable) search.current?.focus({ preventScroll: true });
    else listbox.current?.focus({ preventScroll: true });
  }, [open, searchable, portalTarget, Boolean(position)]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        trigger.current?.contains(event.target) ||
        popup.current?.contains(event.target)
      )
        return;
      close(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);

  useEffect(() => {
    if (open && (disabled || loading)) setOpen(false);
  }, [disabled, loading, open]);
  useEffect(() => {
    if (!open) return;
    if (highlighted >= visibleOptions.length) setHighlighted(visibleOptions.length - 1);
    else if (highlighted < 0 && visibleOptions.length) setHighlighted(0);
  }, [open, highlighted, visibleOptions.length]);
  useLayoutEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId, position?.maxHeight]);

  let previousGroup: string | undefined;
  const controlStyle = stylex.props(styles.control, variant === 'field' && styles.fieldControl, style);
  const triggerStyle = stylex.props(
    styles.trigger,
    variant === 'field' && styles.fieldTrigger,
    variant === 'quiet' && styles.quietTrigger,
    open && styles.openTrigger,
    open && variant === 'field' && styles.openFieldTrigger,
    open && variant === 'quiet' && styles.openQuietTrigger,
    !selected && !value && styles.placeholder,
    (disabled || loading) && styles.disabledTrigger,
    triggerOverride,
  );
  return (
    <div {...controlStyle} className={`${`select-control ${className}`} ${controlStyle.className}`}>
      <button
        id={triggerId}
        ref={trigger}
        {...triggerStyle}
        className={`select-trigger ${triggerStyle.className}`}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!searchable ? activeId : undefined}
        aria-busy={loading || undefined}
        data-value={value}
        disabled={disabled || loading}
        title={title || selected?.label || value || placeholder}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={handleKey}
      >
        {icon && (
          <span {...stylex.props(styles.triggerIcon)}>
            {isValidElement<{ className?: string }>(icon)
              ? cloneElement(icon, {
                  className: `${icon.props.className || ''} ${stylex.props(styles.triggerIconSvg).className}`,
                })
              : icon}
          </span>
        )}
        <span {...stylex.props(styles.value)}>{selected?.label || value || placeholder}</span>
        {loading ? (
          <LoaderCircle size={13} {...stylex.props(styles.chevron, styles.spinner)} />
        ) : (
          <ChevronDown size={12} {...stylex.props(styles.chevron, open && styles.openChevron)} />
        )}
      </button>
      {open &&
        portalTarget &&
        createPortal(
          <div
            ref={popup}
            {...stylex.props(styles.popup)}
            style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
            onKeyDown={handleKey}
          >
            {searchable && (
              <div {...stylex.props(styles.search)}>
                <Search size={14} {...stylex.props(styles.searchIcon)} />
                <input
                  ref={search}
                  {...stylex.props(styles.searchInput)}
                  role="searchbox"
                  aria-label="Search options"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  placeholder={searchPlaceholder}
                  value={query}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlighted(0);
                  }}
                />
              </div>
            )}
            <div
              id={listId}
              ref={listbox}
              role="listbox"
              aria-label={`${label} options`}
              tabIndex={-1}
              aria-activedescendant={!searchable ? activeId : undefined}
              {...stylex.props(styles.options)}
            >
              {visibleOptions.map((option, index) => {
                const group = option.group && option.group !== previousGroup ? option.group : undefined;
                previousGroup = option.group;
                return (
                  <div key={option.value} role="presentation">
                    {group && (
                      <div {...stylex.props(styles.group)} role="presentation">
                        {group}
                      </div>
                    )}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-label={option.label}
                      aria-selected={value === option.value}
                      {...stylex.props(
                        styles.option,
                        highlighted === index && styles.highlightedOption,
                        value === option.value && styles.selectedOption,
                      )}
                      title={option.description ? `${option.label}\n${option.description}` : option.label}
                      onPointerMove={() => {
                        if (highlighted !== index) setHighlighted(index);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                    >
                      <span {...stylex.props(styles.optionLabel)}>{option.label}</span>
                      {option.description && (
                        <span
                          {...stylex.props(
                            styles.optionDescription,
                            highlighted === index && styles.highlightedDescription,
                          )}
                        >
                          {option.description}
                        </span>
                      )}
                      <span {...stylex.props(styles.optionCheck)}>
                        {value === option.value && <Check size={13} />}
                      </span>
                    </div>
                  </div>
                );
              })}
              {!visibleOptions.length && (
                <div {...stylex.props(styles.empty)} role="status">
                  No matching options
                </div>
              )}
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
