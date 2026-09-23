import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Clock3, LoaderCircle, Search, TriangleAlert } from 'lucide-react';
import type { JiraTicketOption, JiraTicketSuggestions } from '../../shared/integrations';

const emptySuggestions = (): JiraTicketSuggestions => ({ recent: [], matches: [] });
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

export function JiraTicketSelect({ id, reviewId, value, disabled, onChange, onSelect }: {
  id: string; reviewId: string; value: string; disabled: boolean;
  onChange: (value: string) => void; onSelect: (key: string) => void;
}) {
  const listId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<JiraTicketSuggestions>(emptySuggestions);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [placement, setPlacement] = useState({ above: false, maxHeight: 320 });
  const options = [...suggestions.recent, ...suggestions.matches];
  const expanded = open && !disabled;

  useEffect(() => {
    const generation = ++request.current;
    setSuggestions(emptySuggestions()); setActive(-1); setError('');
    if (!expanded) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void window.reviewAPI.getJiraTicketSuggestions(reviewId, query.trim()).then(result => {
        if (request.current === generation) {
          setSuggestions(result);
          const searchingByTitle = !!query.trim() && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(query.trim());
          setActive(searchingByTitle && result.recent.length + result.matches.length > 0 ? 0 : -1);
        }
      }).catch(reason => {
        if (request.current === generation) setError(message(reason));
      }).finally(() => { if (request.current === generation) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); request.current++; };
  }, [expanded, query, reviewId]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur); };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const position = () => {
      const rect = container.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const openAbove = below < 240 && above > below;
      setPlacement({ above: openAbove, maxHeight: Math.max(100, Math.min(320, openAbove ? above : below)) });
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [expanded, loading, error]);

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  function showRecent() {
    if (disabled || expanded) return;
    setQuery(''); setOpen(true); setActive(-1); setSuggestions(emptySuggestions()); setError('');
    input.current?.select();
  }
  function choose(option: JiraTicketOption) {
    request.current++;
    setOpen(false); setActive(-1);
    onChange(option.key);
    onSelect(option.key);
  }
  function row(option: JiraTicketOption, index: number) {
    return <div id={`${listId}-${index}`} key={option.key} role="option" aria-selected={active === index}
      className={`jira-ticket-option ${active === index ? 'active' : ''}`}
      onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
      <strong>{option.key}</strong><span>{option.title}</span>
    </div>;
  }

  return <div ref={container} className="jira-ticket-select" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    {expanded && <div className="jira-ticket-popup" data-above={placement.above} style={{ maxHeight: placement.maxHeight }}>
      <div className="jira-ticket-search-heading">{query.trim() ? <Search size={12} /> : <Clock3 size={12} />}<span>{query.trim() ? 'Search Jira' : 'Recent tickets'}</span></div>
      {loading && <div className="jira-ticket-search-status" role="status"><LoaderCircle size={13} className="spin" />{query.trim() ? 'Searching Jira…' : 'Loading recent tickets…'}</div>}
      {error && <div className="jira-ticket-search-status jira-ticket-search-error" role="alert"><TriangleAlert size={13} /><span>{error}<small>You can still enter a ticket key and choose Use ticket.</small></span></div>}
      <div id={listId} role="listbox" aria-label="Jira tickets" aria-busy={loading} className="jira-ticket-options">
        {suggestions.recent.length > 0 && <div role="group" aria-label="Recent tickets">{query.trim() && <div className="jira-ticket-group-label">Recent tickets</div>}{suggestions.recent.map(row)}</div>}
        {suggestions.matches.length > 0 && <div role="group" aria-label="Matching tickets"><div className="jira-ticket-group-label">Matching tickets</div>{suggestions.matches.map((option, index) => row(option, index + suggestions.recent.length))}</div>}
      </div>
      {!loading && !error && !options.length && <div className="jira-ticket-search-status" role="status">{query.trim() ? 'No matching tickets. Try another title or ticket key.' : 'No recent tickets. Type a title or ticket key to search.'}</div>}
      <p id={hintId} className="jira-ticket-search-hint">From your connected Jira account · Search by key or title</p>
    </div>}
    <div className="jira-ticket-select-input">
      <input ref={input} id={id} className="text-input" role="combobox" aria-label="Review ticket key" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-describedby={expanded ? hintId : undefined}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder="Search by ticket key or title" value={value} maxLength={200} disabled={disabled}
        onFocus={showRecent} onClick={showRecent}
        onChange={event => { request.current++; onChange(event.target.value); setQuery(event.target.value); setOpen(true); setSuggestions(emptySuggestions()); setActive(-1); setError(''); setLoading(true); }}
        onKeyDown={event => {
          if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
          if (event.key === 'Tab') { setOpen(false); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!expanded) { showRecent(); return; }
            if (options.length) setActive(previous => event.key === 'ArrowDown' ? (previous + 1) % options.length : (previous < 0 ? options.length - 1 : (previous - 1 + options.length) % options.length));
          }
          if (event.key === 'Enter' && expanded && active >= 0 && options[active]) { event.preventDefault(); choose(options[active]); }
        }} />
      <button type="button" className="jira-ticket-select-toggle" tabIndex={-1} aria-label="Show recent Jira tickets" disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (expanded) setOpen(false); else { showRecent(); input.current?.focus(); } }}><ChevronDown size={13} /></button>
    </div>
  </div>;
}
