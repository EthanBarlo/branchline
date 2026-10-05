import * as stylex from '@stylexjs/stylex';
import { ChevronRight, GitBranch, GitCommitHorizontal, Search, Tag, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommitRef, GitWorkflowSnapshot } from '../../../shared/git-workflow';
import { colors, fonts, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import type { GitSidebarBranch } from './branchTree';
import type { GraphRow } from './commitGraph';
import {
  layoutProjectGraph,
  rowMembers,
  timelineEntryKey,
  timelineRows,
  timelineSearch,
  type TimelineRow,
} from './timeline';
import { useGitHistory } from './useGitHistory';
import { useCommitViewport } from './useCommitViewport';

const rowHeight = 32;
const laneWidth = 16;
const palette = ['#8e9d3d', '#299aa3', '#bf6555', '#687dcc', '#aa76c8', '#b58b49', '#4b9b78'];
const graphX = (lane: number) => 14 + lane * laneWidth;

function GraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
  const outgoing = row.continuations.filter((entry) => !entry.incoming);
  return (
    <svg width={width} height={rowHeight} aria-hidden="true" {...stylex.props(styles.graph)}>
      {row.incoming.map((edge) => (
        <path
          key={edge.lane}
          d={`M ${graphX(edge.lane)} 0 V 16`}
          stroke={palette[edge.color % palette.length]}
          strokeWidth="1.7"
          fill="none"
        />
      ))}
      {row.edges.map((edge, index) => (
        <path
          key={index}
          d={`M ${graphX(edge.from)} 16 L ${graphX(edge.from)} 20 L ${graphX(edge.to)} 32`}
          stroke={palette[edge.color % palette.length]}
          strokeWidth="1.7"
          fill="none"
          strokeLinejoin="round"
        />
      ))}
      {row.continuations
        .filter((entry) => entry.incoming)
        .map((entry) => (
          <path
            key={entry.hash}
            d={`M ${graphX(entry.lane)} 0 V 7 m -3 -3 l 3 3 l 3 -3`}
            stroke={palette[entry.color % palette.length]}
            strokeWidth="1.7"
            fill="none"
          />
        ))}
      {!!outgoing.length && (
        <path
          d={`M ${graphX(row.lane)} 16 l 9 9 m -4 0 h 4 v -4`}
          stroke={palette[row.color % palette.length]}
          strokeWidth="1.7"
          fill="none"
        />
      )}
      <circle
        cx={graphX(row.lane)}
        cy="16"
        r={merge ? 4.5 : 3.5}
        fill={palette[row.color % palette.length]}
      />
      {merge && <circle cx={graphX(row.lane)} cy="16" r="1.7" {...stylex.props(styles.mergeCentre)} />}
    </svg>
  );
}
function RefLabel({ reference, active }: { reference: GitCommitRef; active: boolean }) {
  const Icon =
    reference.kind === 'tag' || reference.kind === 'remote'
      ? Tag
      : reference.kind === 'head'
        ? GitCommitHorizontal
        : GitBranch;
  return (
    <span
      title={`${reference.kind === 'head' ? 'Current checkout' : reference.kind}: ${reference.name}`}
      {...stylex.props(
        styles.ref,
        reference.kind === 'remote' && styles.remoteRef,
        reference.kind === 'tag' && styles.tagRef,
        reference.kind === 'head' && styles.headRef,
        active && styles.activeRef,
      )}
    >
      <Icon size={11} />
      <span {...stylex.props(styles.refText)}>{reference.name}</span>
    </span>
  );
}
function commitDate(date: string) {
  const value = new Date(date);
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const time = value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (value >= day) return `Today ${time}`;
  day.setDate(day.getDate() - 1);
  if (value >= day) return `Yesterday ${time}`;
  return value.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(value.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}
const rowSubject = (row: TimelineRow) =>
  row.entry.commit.subject + (row.group ? ` · ${row.group.length} merges` : '');
const rowRefs = (row: TimelineRow) => [
  ...new Map(
    rowMembers(row)
      .flatMap((entry) => entry.commit.refs)
      .map((ref) => [`${ref.kind}:${ref.name}`, ref]),
  ).values(),
];
function parentLabel(key: string) {
  try {
    const [path, hash] = JSON.parse(key);
    return `${path}: ${hash.slice(0, 7)}`;
  } catch {
    return key;
  }
}

export function GitCommitGraph({
  projectId,
  projectName,
  snapshot,
  branch,
}: {
  projectId: string;
  projectName: string;
  snapshot?: GitWorkflowSnapshot;
  branch?: GitSidebarBranch;
}) {
  const [branchScope, setBranchScope] = useState('all');
  const source = useGitHistory(projectId, branchScope === 'selected' ? branch : undefined, snapshot);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [showDetails, setShowDetails] = useState(false);
  const revealedBranch = useRef<string | undefined>(undefined);
  const selectionAnchor = useRef<string | undefined>(undefined);
  const activeRef = branch ? `${branch.remote ? `${branch.remote}/` : ''}${branch.name}` : undefined;
  useEffect(() => {
    selectionAnchor.current = undefined;
    setSelectedId(undefined);
    setShowDetails(false);
  }, [source.scope]);
  const events = source.projectHistory?.events;
  const rows = useMemo(() => timelineRows(events ?? []), [events]);
  const { viewport, sentinel, first, last, height, nearEnd } = useCommitViewport(
    rows.length,
    rowHeight,
    source.scope,
  );
  useEffect(() => {
    const element = viewport.current;
    if (nearEnd && element && element.scrollHeight - element.scrollTop - element.clientHeight <= 600)
      source.loadOlder();
  }, [nearEnd, source.loadOlder, viewport]);
  const graph = useMemo(() => layoutProjectGraph(rows), [rows]);
  const graphWidth = Math.max(72, graph.lanes * laneWidth + 24);
  const selected = rows.find((row) => row.id === selectedId);
  const selectedIndex = rows.findIndex((row) => row.id === selectedId);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      rows.flatMap((row, index) =>
        !needle || (row.group ?? [row.event]).some((event) => timelineSearch(event).includes(needle))
          ? [index]
          : [],
      ),
    [rows, needle],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);
  function selectRow(row: TimelineRow) {
    selectionAnchor.current = timelineEntryKey(row.entry);
    setSelectedId(row.id);
  }
  useEffect(() => {
    if (!selectedId || rows.some((row) => row.id === selectedId) || !selectionAnchor.current) return;
    const next = rows.find((row) =>
      rowMembers(row).some((entry) => timelineEntryKey(entry) === selectionAnchor.current),
    );
    if (next) setSelectedId(next.id);
  }, [rows, selectedId]);
  function reveal(index: number) {
    if (index < 0 || index >= rows.length) return;
    selectRow(rows[index]);
    const element = viewport.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop || top + rowHeight > element.scrollTop + element.clientHeight - 28)
      element.scrollTop = Math.max(0, top - element.clientHeight / 2 + rowHeight);
  }
  useEffect(() => {
    if (!activeRef || source.loadedScope !== source.scope) return;
    const key = `${source.scope}:${activeRef}`;
    if (revealedBranch.current === key) return;
    const index = rows.findIndex((row) =>
      rowRefs(row).some((ref) => ref.name === activeRef && ref.kind !== 'tag'),
    );
    if (index >= 0) {
      reveal(index);
      revealedBranch.current = key;
    } else if (rows.length && !selectedId) {
      reveal(0);
      revealedBranch.current = key;
    }
  }, [activeRef, source.loadedScope, source.scope, rows]);
  const problems = source.projectHistory?.repositories.filter((repo) => repo.error) ?? [];
  return (
    <section aria-label="Commit history" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.toolbar)}>
        <strong {...stylex.props(styles.heading)}>Log</strong>
        <Select
          label="History branches"
          value={branchScope}
          onChange={setBranchScope}
          options={[
            { value: 'all', label: 'All branches' },
            { value: 'selected', label: 'Selected branch' },
          ]}
        />
        <div {...stylex.props(styles.search)}>
          <Search size={12} />
          <input
            aria-label="Search loaded commits"
            placeholder="Search commits"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            {...stylex.props(styles.searchInput)}
          />
          {needle && <span {...stylex.props(styles.count)}>{matches.length} matches</span>}
          {needle && (
            <Button
              disabled={!matches.length}
              onClick={() => reveal(matches.find((index) => index > selectedIndex) ?? matches[0])}
            >
              Next
            </Button>
          )}
        </div>
        {source.loading && <Spinner size={12} />}
      </div>
      {source.error && (
        <div role="alert" {...stylex.props(styles.error)}>
          {source.error} <Button onClick={source.retry}>Retry</Button>
        </div>
      )}
      {!!problems.length && (
        <details {...stylex.props(styles.repositoryErrors)}>
          <summary>
            {problems.length} {problems.length === 1 ? 'repository unavailable' : 'repositories unavailable'}
          </summary>
          {problems.map((repo) => (
            <p key={repo.path}>
              {repo.path === '.' ? projectName : repo.path}: {repo.error}
            </p>
          ))}
        </details>
      )}
      <div
        ref={viewport}
        role="grid"
        aria-label="Commit log"
        data-loaded-commits={events?.length ?? 0}
        data-history-has-more={source.projectHistory?.hasMore ?? true}
        data-history-loading={source.loading}
        aria-rowcount={rows.length + 1}
        aria-colcount={6}
        aria-activedescendant={
          selected && first <= selectedIndex && selectedIndex < last
            ? `timeline-row-${selectedIndex}`
            : undefined
        }
        tabIndex={0}
        {...stylex.props(styles.viewport)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            const step = Math.max(1, Math.floor(height / rowHeight) - 1);
            reveal(
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        rows.length - 1,
                        selectedIndex +
                          (event.key === 'ArrowDown'
                            ? 1
                            : event.key === 'ArrowUp'
                              ? -1
                              : event.key === 'PageDown'
                                ? step
                                : -step),
                      ),
                    ),
            );
          }
          if (selected && ['Enter', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault();
            setShowDetails(event.key !== 'ArrowLeft');
          }
        }}
      >
        <div role="row" aria-rowindex={1} {...stylex.props(styles.row(graphWidth), styles.header)}>
          {['Author', 'Date', 'Graph', 'Commit message', 'Repositories / branches', 'Hash'].map(
            (label, index) => (
              <div role="columnheader" key={index} {...stylex.props(styles.cell)}>
                {label}
              </div>
            ),
          )}
        </div>
        <div role="rowgroup">
          <div aria-hidden="true" {...stylex.props(styles.spacer(first * rowHeight))} />
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const commit = row.entry.commit;
            const members = rowMembers(row);
            const merge = commit.parents.length > 1;
            const authors = [...new Set(members.map((member) => member.commit.author))];
            const paths = [...new Set(members.map((member) => member.repositoryPath))];
            const refs = rowRefs(row).sort(
              (left, right) =>
                Number(right.kind === 'head' || right.name === activeRef) -
                Number(left.kind === 'head' || left.name === activeRef),
            );
            const continuations = graph.rows[index].continuations;
            return (
              <div
                id={`timeline-row-${index}`}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={selectedId === row.id}
                key={row.id}
                data-commit-hash={commit.hash}
                data-repository-path={row.entry.repositoryPath}
                data-timeline-kind={row.kind}
                {...stylex.props(
                  styles.row(graphWidth),
                  styles.commitRow,
                  merge && styles.mergeRow,
                  row.group && styles.groupRow,
                  !!needle && !matchSet.has(index) && styles.dimmed,
                  selectedId === row.id && styles.selectedRow,
                )}
                onClick={() => {
                  selectRow(row);
                  viewport.current?.focus({ preventScroll: true });
                }}
                onDoubleClick={() => {
                  selectRow(row);
                  setShowDetails(true);
                }}
              >
                <div
                  role="gridcell"
                  title={members
                    .map((member) => `${member.commit.author} <${member.commit.email}>`)
                    .join('\n')}
                  {...stylex.props(styles.cell, styles.author)}
                >
                  {authors.length > 1 ? 'Multiple authors' : commit.author}
                </div>
                <div
                  role="gridcell"
                  title={members.map((member) => new Date(member.commit.date).toLocaleString()).join('\n')}
                  {...stylex.props(styles.cell, styles.date)}
                >
                  {commitDate(commit.committedAt ?? commit.date)}
                </div>
                <div
                  role="gridcell"
                  aria-label={
                    continuations.length
                      ? `History continues: ${continuations.map((entry) => parentLabel(entry.hash)).join(', ')}`
                      : undefined
                  }
                  title={
                    continuations.length
                      ? `Continue at ${continuations.map((entry) => parentLabel(entry.hash)).join(', ')} · Some ancestry is outside this view`
                      : undefined
                  }
                >
                  <GraphCell row={graph.rows[index]} width={graphWidth} merge={merge} />
                </div>
                <div role="gridcell" title={rowSubject(row)} {...stylex.props(styles.cell, styles.subject)}>
                  <span>{rowSubject(row)}</span>
                  {row.group && (
                    <button
                      type="button"
                      aria-label={`Show ${row.group.length} grouped merges`}
                      title="Show original merge commits"
                      {...stylex.props(styles.disclosure)}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectRow(row);
                        setShowDetails(true);
                      }}
                    >
                      <ChevronRight size={12} />
                    </button>
                  )}
                </div>
                <div
                  role="gridcell"
                  title={members.map((entry) => `${entry.repositoryPath}: ${entry.commit.hash}`).join('\n')}
                  {...stylex.props(styles.refs)}
                >
                  <span {...stylex.props(styles.repositoryLabel)}>
                    {paths.length > 1
                      ? `${paths.length} repositories`
                      : row.entry.repositoryPath === '.'
                        ? projectName
                        : row.entry.repositoryPath}
                  </span>
                  {refs.map((reference) => (
                    <RefLabel
                      key={`${reference.kind}:${reference.name}`}
                      reference={reference}
                      active={reference.name === activeRef && reference.kind !== 'tag'}
                    />
                  ))}
                </div>
                <div role="gridcell" {...stylex.props(styles.cell, styles.hash)}>
                  {row.group ? `${members.length} commits` : commit.hash.slice(0, 7)}
                </div>
              </div>
            );
          })}
          <div
            aria-hidden="true"
            {...stylex.props(styles.spacer(Math.max(0, rows.length - last) * rowHeight))}
          />
        </div>
        <div ref={sentinel} aria-hidden="true" {...stylex.props(styles.spacer(1))} />
        {!rows.length && !source.error && (
          <div role="status" {...stylex.props(styles.empty)}>
            {source.loading || !source.ready ? 'Reading commit history…' : 'No commits in this view.'}
          </div>
        )}
      </div>
      {showDetails && selected && (
        <CommitDetails
          key={selected.id}
          row={selected}
          projectName={projectName}
          onClose={() => setShowDetails(false)}
        />
      )}
    </section>
  );
}
function CommitDetails({
  row,
  projectName,
  onClose,
}: {
  row: TimelineRow;
  projectName: string;
  onClose: () => void;
}) {
  const members = rowMembers(row);
  return (
    <section aria-label="Commit details" {...stylex.props(styles.details)}>
      <div {...stylex.props(styles.detailHeading)}>
        <strong>{rowSubject(row)}</strong>
        <Button aria-label="Close commit details" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>
      {members.map((entry) => {
        const commit = entry.commit;
        return (
          <details
            key={timelineEntryKey(entry)}
            open={members.length === 1}
            {...stylex.props(styles.entryDetails)}
          >
            <summary>
              {entry.repositoryPath === '.' ? projectName : entry.repositoryPath} · {commit.subject} ·{' '}
              {commit.hash.slice(0, 7)}
            </summary>
            <div {...stylex.props(styles.detailMeta)}>
              <span>
                {commit.author} &lt;{commit.email}&gt;
              </span>
              <span>{new Date(commit.date).toLocaleString()}</span>
            </div>
            <div {...stylex.props(styles.detailMeta, styles.code)}>
              <span>Commit {commit.hash}</span>
              <span>
                {commit.parents.length
                  ? `Parents ${commit.parents.map((hash) => hash.slice(0, 7)).join(', ')}`
                  : 'Root commit'}
              </span>
            </div>
            {!!commit.refs.length && (
              <div {...stylex.props(styles.refs)}>
                {commit.refs.map((reference) => (
                  <RefLabel
                    key={`${reference.kind}:${reference.name}`}
                    reference={reference}
                    active={false}
                  />
                ))}
              </div>
            )}
            {commit.body && <pre {...stylex.props(styles.message)}>{commit.body}</pre>}
          </details>
        );
      })}
    </section>
  );
}
const styles = stylex.create({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1',
    minHeight: 160,
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: colors.canvas,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    minHeight: 40,
    paddingInline: 12,
    flexWrap: 'wrap',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  groupRow: {
    backgroundColor: { default: colors.panel, ':hover': colors.translucentHover },
    fontWeight: 550,
  },
  disclosure: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 20,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: 3,
    cursor: 'pointer',
    color: colors.textSecondary,
    backgroundColor: { default: 'transparent', ':hover': colors.interactive },
    outline: { default: null, ':focus-visible': `1px solid ${colors.focus}` },
  },
  repositoryLabel: { flexShrink: 0, fontSize: typeScale.compact, color: colors.textSecondary },
  repositoryErrors: {
    flexShrink: 0,
    padding: 8,
    fontSize: typeScale.compact,
    color: colors.warningStrong,
    backgroundColor: colors.warningSurface,
  },
  entryDetails: {
    marginTop: 10,
    fontSize: typeScale.compact,
    cursor: 'default',
    color: colors.textSecondary,
  },
  heading: { fontSize: typeScale.body, color: colors.textSecondary, marginRight: 4 },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: '1',
    minWidth: 140,
    maxWidth: 380,
    marginLeft: 'auto',
    color: colors.textMuted,
  },
  searchInput: {
    width: '100%',
    minWidth: 40,
    backgroundColor: 'transparent',
    borderWidth: 0,
    fontSize: typeScale.compact,
    fontFamily: fonts.body,
    color: colors.textPrimary,
    padding: 5,
    outline: { default: null, ':focus-visible': `1px solid ${colors.focus}` },
    borderRadius: 3,
  },
  count: { fontSize: typeScale.small, whiteSpace: 'nowrap', flexShrink: 0 },
  viewport: {
    flex: '1',
    minHeight: 0,
    overflow: 'auto',
    outline: { default: null, ':focus-visible': `1px solid ${colors.focus}` },
    outlineOffset: -1,
    position: 'relative',
    overflowAnchor: 'none',
    scrollbarGutter: 'stable',
  },
  row: (width: number) => ({
    display: 'grid',
    gridTemplateColumns: `140px 125px ${width}px minmax(240px, 1fr) 210px 96px`,
    minWidth: 140 + 125 + width + 240 + 210 + 96,
    height: rowHeight,
    alignItems: 'center',
    fontSize: typeScale.body,
    color: colors.textDefault,
  }),
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    height: 28,
    backgroundColor: colors.panel,
    color: colors.textMuted,
    fontSize: typeScale.small,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  commitRow: {
    cursor: 'default',
    backgroundColor: { default: 'transparent', ':hover': colors.translucentHover },
  },
  selectedRow: {
    backgroundColor: { default: colors.translucentSelected, ':hover': colors.translucentSelected },
    color: colors.textPrimary,
  },
  mergeRow: { color: colors.textMuted },
  dimmed: { opacity: 0.38 },
  cell: {
    paddingInline: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  author: { fontWeight: 550 },
  date: { color: colors.textMuted, fontSize: typeScale.compact, fontVariantNumeric: 'tabular-nums' },
  subject: { paddingLeft: 6, display: 'flex', alignItems: 'center', gap: 6 },
  hash: { fontFamily: fonts.code, fontSize: typeScale.small, color: colors.textQuiet },
  graph: { display: 'block', overflow: 'visible' },
  mergeCentre: { fill: colors.canvas },
  refs: { display: 'flex', gap: 5, alignItems: 'center', overflow: 'hidden', minWidth: 0, paddingInline: 6 },
  ref: {
    display: 'inline-flex',
    gap: 4,
    alignItems: 'center',
    flexShrink: 0,
    maxWidth: 175,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: typeScale.compact,
    color: colors.successText,
    paddingInline: 5,
    paddingBlock: 2,
    borderRadius: 3,
    backgroundColor: colors.successSurface,
  },
  refText: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
  remoteRef: { color: '#a17bc6', backgroundColor: 'transparent' },
  tagRef: { color: colors.warningStrong, backgroundColor: colors.warningSurface },
  headRef: { color: colors.textSecondary, backgroundColor: colors.raised, fontWeight: 600 },
  activeRef: { outline: `1px solid ${colors.borderSelected}`, outlineOffset: -1 },
  spacer: (height: number) => ({ height }),
  empty: { padding: 32, textAlign: 'center', fontSize: typeScale.body, color: colors.textMuted },
  error: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    fontSize: typeScale.compact,
    color: colors.dangerText,
    backgroundColor: colors.dangerSurface,
  },
  details: {
    flexShrink: 0,
    maxHeight: 200,
    overflowY: 'auto',
    padding: 16,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.panel,
    fontSize: typeScale.body,
    color: colors.textPrimary,
  },
  detailHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  detailMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    marginTop: 8,
    color: colors.textMuted,
    fontSize: typeScale.compact,
  },
  code: { fontFamily: fonts.code, marginBottom: 8 },
  message: {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    marginTop: 12,
    marginBottom: 0,
    lineHeight: 1.6,
  },
});
