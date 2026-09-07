import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react';
import './select.css';

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
  icon?: ReactNode;
  title?: string;
  variant?: 'compact' | 'field' | 'quiet';
}

interface PopupPosition { top: number; left: number; width: number; maxHeight: number }

function matches(option: SelectOption, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [option.label, option.value, option.description || ''].some(text => text.toLocaleLowerCase().includes(needle));
}

export function Select({
  id, label, value, options, onChange, placeholder = 'Select an option', searchable = true,
  searchPlaceholder = 'Search…', disabled = false, loading = false, className = '', icon, title, variant = 'compact',
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
  const selected = options.find(option => option.value === value);
  const visibleOptions = useMemo(() => options.filter(option => matches(option, query)), [options, query]);
  const optionId = (index: number) => `${listId}-${index}`;
  const activeId = open && highlighted >= 0 && highlighted < visibleOptions.length ? optionId(highlighted) : undefined;

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  function show(initial?: 'first' | 'last') {
    if (disabled || loading) return;
    setQuery('');
    setPosition(null);
    setPortalTarget(trigger.current?.closest<HTMLElement>('.modal') || document.body);
    const selectedIndex = options.findIndex(option => option.value === value);
    setHighlighted(initial === 'first' ? 0 : initial === 'last' ? options.length - 1 : Math.max(0, selectedIndex));
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
    const controls = Array.from(scope.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
    )).filter(element => element.offsetParent !== null && !popup.current?.contains(element) && element.getAttribute('aria-hidden') !== 'true');
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
        show(event.key === 'Home' ? 'first' : event.key === 'End' || event.key === 'ArrowUp' ? 'last' : undefined);
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
      setHighlighted(previous => visibleOptions.length ? (previous + (event.key === 'ArrowDown' ? 1 : -1) + visibleOptions.length) % visibleOptions.length : -1);
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
      const desiredHeight = Math.min(326, 8 + (searchable ? 42 : 0) + (visibleOptions.length ? visibleOptions.length * 32 + groupCount * 24 : 56));
      const below = viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const flip = below < Math.min(desiredHeight, 180) && above > below;
      const maxHeight = Math.max(40, Math.min(desiredHeight, flip ? above : below));
      setPosition({
        top: flip ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap,
        left: Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)),
        width, maxHeight,
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
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); observer.disconnect(); };
  }, [open, portalTarget, searchable, visibleOptions]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    if (searchable) search.current?.focus({ preventScroll: true });
    else listbox.current?.focus({ preventScroll: true });
  }, [open, searchable, portalTarget, Boolean(position)]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || trigger.current?.contains(event.target) || popup.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);

  useEffect(() => { if (open && (disabled || loading)) setOpen(false); }, [disabled, loading, open]);
  useEffect(() => {
    if (!open) return;
    if (highlighted >= visibleOptions.length) setHighlighted(visibleOptions.length - 1);
    else if (highlighted < 0 && visibleOptions.length) setHighlighted(0);
  }, [open, highlighted, visibleOptions.length]);
  useLayoutEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId, position?.maxHeight]);

  let previousGroup: string | undefined;
  return <div className={`select-control select-${variant} ${open ? 'is-open' : ''} ${disabled || loading ? 'is-disabled' : ''} ${className}`}>
    <button id={triggerId} ref={trigger} className={`select-trigger ${!selected && !value ? 'is-placeholder' : ''}`} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-activedescendant={!searchable ? activeId : undefined} aria-busy={loading || undefined} data-value={value} disabled={disabled || loading} title={title || selected?.label || value || placeholder} onClick={() => open ? close(true) : show()} onKeyDown={handleKey}>
      {icon && <span className="select-trigger-icon">{icon}</span>}
      <span className="select-value">{selected?.label || value || placeholder}</span>
      {loading ? <LoaderCircle size={13} className="select-chevron select-spinner" /> : <ChevronDown size={12} className="select-chevron" />}
    </button>
    {open && portalTarget && createPortal(<div ref={popup} className={`select-popup ${searchable ? 'is-searchable' : ''}`} style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={handleKey}>
      {searchable && <div className="select-search"><Search size={14} /><input ref={search} role="searchbox" aria-label="Search options" aria-controls={listId} aria-activedescendant={activeId} placeholder={searchPlaceholder} value={query} autoComplete="off" autoCorrect="off" spellCheck={false} onChange={event => { setQuery(event.target.value); setHighlighted(0); }} /></div>}
      <div id={listId} ref={listbox} role="listbox" aria-label={`${label} options`} tabIndex={-1} aria-activedescendant={!searchable ? activeId : undefined} className="select-options">
        {visibleOptions.map((option, index) => {
          const group = option.group && option.group !== previousGroup ? option.group : undefined;
          previousGroup = option.group;
          return <div key={option.value} role="presentation">
            {group && <div className="select-group" role="presentation">{group}</div>}
            <div id={optionId(index)} role="option" aria-label={option.label} aria-selected={value === option.value} className={`select-option ${highlighted === index ? 'is-highlighted' : ''} ${value === option.value ? 'is-selected' : ''}`} title={option.description ? `${option.label}\n${option.description}` : option.label} onPointerMove={() => { if (highlighted !== index) setHighlighted(index); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
              <span className="select-option-label">{option.label}</span>
              {option.description && <span className="select-option-description">{option.description}</span>}
              <span className="select-option-check">{value === option.value && <Check size={13} />}</span>
            </div>
          </div>;
        })}
        {!visibleOptions.length && <div className="select-empty" role="status">No matching options</div>}
      </div>
    </div>, portalTarget)}
  </div>;
}
