import * as stylex from '@stylexjs/stylex';
import { ChevronDown, Clock3, Search, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { JiraTicketOption, JiraTicketSuggestions } from '../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { Spinner } from '../../ui/Spinner';

const emptySuggestions = (): JiraTicketSuggestions => ({ recent: [], matches: [] });
const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error);

const styles = stylex.create({
  select: { position: 'relative', width: '100%', minWidth: 0 },
  inputContainer: { position: 'relative' },
  input: { width: '100%', height: 38, paddingRight: 36, paddingLeft: 12, fontSize: typeScale.body },
  toggle: {
    position: 'absolute',
    right: 3,
    top: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.md,
    color: { default: colors.textMuted, ':hover': colors.textPrimary },
    backgroundColor: { default: 'transparent', ':hover': colors.translucentHover },
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.4 },
  },
  popup: {
    position: 'absolute',
    zIndex: 2,
    top: 'calc(100% + 7px)',
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: 7,
    backgroundColor: colors.raised,
    overflow: 'hidden',
    boxShadow: `0 8px 25px ${colors.shadow}`,
  },
  popupAbove: { top: 'auto', bottom: 'calc(100% + 7px)' },
  fixedPopupChild: { flexShrink: 0 },
  searchHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    paddingBlock: '9px',
    paddingInline: '10px',
    color: colors.accent,
    fontSize: typeScale.small,
    fontWeight: 500,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  options: { minHeight: 0, maxHeight: 240, overflowY: 'auto', overscrollBehavior: 'contain' },
  groupLabel: {
    paddingTop: '7px',
    paddingRight: '10px',
    paddingBottom: '4px',
    paddingLeft: '10px',
    fontSize: typeScale.caption,
    color: colors.textQuiet,
  },
  option: {
    display: 'grid',
    gridTemplateColumns: '92px minmax(0, 1fr)',
    alignItems: 'baseline',
    gap: 7,
    paddingBlock: '9px',
    paddingInline: '10px',
    cursor: 'pointer',
    color: colors.textEmphasis,
    fontSize: typeScale.compact,
    lineHeight: 1.5,
  },
  activeOption: { backgroundColor: colors.interactive, color: colors.textStrong },
  optionKey: { fontFamily: fonts.code, fontSize: typeScale.small, overflowWrap: 'anywhere' },
  optionTitle: { overflowWrap: 'anywhere' },
  searchStatus: {
    display: 'flex',
    gap: 7,
    alignItems: 'flex-start',
    paddingBlock: '12px',
    paddingInline: '10px',
    fontSize: typeScale.small,
    color: colors.textMuted,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
  },
  statusIcon: { flexShrink: 0, marginTop: 1 },
  statusHint: { display: 'block', marginTop: 6, fontSize: typeScale.small, color: colors.textMuted },
  searchError: { color: colors.warningText },
  searchHint: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    margin: 0,
    paddingBlock: spacing.md,
    paddingInline: '10px',
    color: colors.textQuiet,
    fontSize: typeScale.caption,
    lineHeight: 1.5,
  },
  'text-input': {
    width: '100%',
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '5px',
    minHeight: '37px',
    paddingBlock: '0',
    paddingInline: '11px',
    color: colors.textDefault,
    fontSize: typeScale.compact,
    borderColor: { default: colors.borderStrong, ':focus': colors.textSubtle },
    '::placeholder': { color: colors.textFaint, opacity: '1' },
  },
});

export function JiraTicketSelect({
  id,
  reviewId,
  value,
  disabled,
  onChange,
  onSelect,
}: {
  id: string;
  reviewId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSelect: (key: string) => void;
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
    setSuggestions(emptySuggestions());
    setActive(-1);
    setError('');
    if (!expanded) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      () => {
        void window.reviewAPI
          .getJiraTicketSuggestions(reviewId, query.trim())
          .then((result) => {
            if (request.current === generation) {
              setSuggestions(result);
              const searchingByTitle = !!query.trim() && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(query.trim());
              setActive(searchingByTitle && result.recent.length + result.matches.length > 0 ? 0 : -1);
            }
          })
          .catch((reason) => {
            if (request.current === generation) setError(message(reason));
          })
          .finally(() => {
            if (request.current === generation) setLoading(false);
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [expanded, query, reviewId]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', blur);
    };
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
    setQuery('');
    setOpen(true);
    setActive(-1);
    setSuggestions(emptySuggestions());
    setError('');
    input.current?.select();
  }
  function choose(option: JiraTicketOption) {
    request.current++;
    setOpen(false);
    setActive(-1);
    onChange(option.key);
    onSelect(option.key);
  }
  function row(option: JiraTicketOption, index: number) {
    return (
      <div
        id={`${listId}-${index}`}
        key={option.key}
        role="option"
        aria-selected={active === index}
        className={`jira-ticket-option ${active === index ? 'active' : ''} ${stylex.props(styles.option, active === index && styles.activeOption).className}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActive(index)}
        onClick={() => choose(option)}
      >
        <strong {...stylex.props(styles.optionKey)}>{option.key}</strong>
        <span {...stylex.props(styles.optionTitle)}>{option.title}</span>
      </div>
    );
  }

  return (
    <div
      ref={container}
      className={`jira-ticket-select ${stylex.props(styles.select).className}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {expanded && (
        <div
          className={`jira-ticket-popup ${stylex.props(styles.popup, placement.above && styles.popupAbove).className}`}
          data-above={placement.above}
          style={{ maxHeight: placement.maxHeight }}
        >
          <div
            className={`jira-ticket-search-heading ${stylex.props(styles.fixedPopupChild, styles.searchHeading).className}`}
          >
            {query.trim() ? <Search size={12} /> : <Clock3 size={12} />}
            <span>{query.trim() ? 'Search Jira' : 'Recent tickets'}</span>
          </div>
          {loading && (
            <div
              className={`jira-ticket-search-status ${stylex.props(styles.fixedPopupChild, styles.searchStatus).className}`}
              role="status"
            >
              <Spinner size={13} />
              {query.trim() ? 'Searching Jira…' : 'Loading recent tickets…'}
            </div>
          )}
          {error && (
            <div
              className={`jira-ticket-search-status jira-ticket-search-error ${stylex.props(styles.fixedPopupChild, styles.searchStatus, styles.searchError).className}`}
              role="alert"
            >
              <TriangleAlert size={13} className={stylex.props(styles.statusIcon).className} />
              <span>
                {error}
                <small className={`jira-ticket-search-hint ${stylex.props(styles.statusHint).className}`}>
                  You can still enter a ticket key and choose Use ticket.
                </small>
              </span>
            </div>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label="Jira tickets"
            aria-busy={loading}
            className={`jira-ticket-options ${stylex.props(styles.options).className}`}
          >
            {suggestions.recent.length > 0 && (
              <div role="group" aria-label="Recent tickets">
                {query.trim() && (
                  <div className={`jira-ticket-group-label ${stylex.props(styles.groupLabel).className}`}>
                    Recent tickets
                  </div>
                )}
                {suggestions.recent.map(row)}
              </div>
            )}
            {suggestions.matches.length > 0 && (
              <div role="group" aria-label="Matching tickets">
                <div className={`jira-ticket-group-label ${stylex.props(styles.groupLabel).className}`}>
                  Matching tickets
                </div>
                {suggestions.matches.map((option, index) => row(option, index + suggestions.recent.length))}
              </div>
            )}
          </div>
          {!loading && !error && !options.length && (
            <div
              className={`jira-ticket-search-status ${stylex.props(styles.fixedPopupChild, styles.searchStatus).className}`}
              role="status"
            >
              {query.trim()
                ? 'No matching tickets. Try another title or ticket key.'
                : 'No recent tickets. Type a title or ticket key to search.'}
            </div>
          )}
          <p
            id={hintId}
            className={`jira-ticket-search-hint ${stylex.props(styles.fixedPopupChild, styles.searchHint).className}`}
          >
            From your connected Jira account · Search by key or title
          </p>
        </div>
      )}
      <div className={`jira-ticket-select-input ${stylex.props(styles.inputContainer).className}`}>
        <input
          ref={input}
          id={id}
          className={`text-input ${stylex.props(styles['text-input'], styles.input).className}`}
          role="combobox"
          aria-label="Review ticket key"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-describedby={expanded ? hintId : undefined}
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          placeholder="Search by ticket key or title"
          value={value}
          maxLength={200}
          disabled={disabled}
          onFocus={showRecent}
          onClick={showRecent}
          onChange={(event) => {
            request.current++;
            onChange(event.target.value);
            setQuery(event.target.value);
            setOpen(true);
            setSuggestions(emptySuggestions());
            setActive(-1);
            setError('');
            setLoading(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && expanded) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              return;
            }
            if (event.key === 'Tab') {
              setOpen(false);
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!expanded) {
                showRecent();
                return;
              }
              if (options.length)
                setActive((previous) =>
                  event.key === 'ArrowDown'
                    ? (previous + 1) % options.length
                    : previous < 0
                      ? options.length - 1
                      : (previous - 1 + options.length) % options.length,
                );
            }
            if (event.key === 'Enter' && expanded && active >= 0 && options[active]) {
              event.preventDefault();
              choose(options[active]);
            }
          }}
        />
        <button
          type="button"
          className={`jira-ticket-select-toggle ${stylex.props(styles.toggle).className}`}
          tabIndex={-1}
          aria-label="Show recent Jira tickets"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (expanded) setOpen(false);
            else {
              showRecent();
              input.current?.focus();
            }
          }}
        >
          <ChevronDown size={13} />
        </button>
      </div>
    </div>
  );
}
