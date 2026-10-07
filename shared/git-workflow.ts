export type GitAction = 'checkout' | 'pull' | 'push' | 'create' | 'rename' | 'delete';

export interface GitDestination {
  remote: string;
  branch: string;
  commit: string | null;
  url?: string;
}

export interface GitRepositoryStatus {
  path: string;
  branch: string | null;
  head: string;
  remotes: string[];
  upstream?: GitDestination;
  pushTarget?: GitDestination;
  incoming: number | null;
  outgoing: number | null;
  diverged: boolean;
  changes: number;
  pointerChanges: string[];
  lastFetched?: string;
  fetchError?: string;
  error?: string;
}

export interface GitBranchChoice {
  name: string;
  remote?: string;
  kind?: 'local' | 'remote';
}

export interface GitRemoteBranchStatus {
  head: string;
  incoming: number | null;
  outgoing: number | null;
  diverged: boolean;
}

export interface GitBranchRepository {
  path: string;
  local: boolean;
  remotes: string[];
  remoteStatus?: Record<string, GitRemoteBranchStatus>;
  current: boolean;
  incoming: number | null;
  outgoing: number | null;
  diverged: boolean;
  upstream?: GitDestination;
  pushTarget?: GitDestination;
  error?: string;
}

/** One logical branch across the root and all recursively discovered submodules. */
export interface GitProjectBranch {
  name: string;
  repositories: GitBranchRepository[];
}

export interface GitActionInput {
  action: GitAction;
  branch?: GitBranchChoice;
  /** New local name for create or rename. */
  newBranch?: string;
  /** Explicit first-publication remote for each repository-relative path. */
  publishRemotes?: Record<string, string>;
  /** Explicit permission to delete unmerged local branches. */
  force?: boolean;
  /** Also delete the local branch's remote counterpart. */
  deleteRemote?: boolean;
  /** Explicit remote choice where a local branch has multiple possible remotes. */
  deleteRemotes?: Record<string, string>;
}

export interface GitActionRow {
  path: string;
  branch: string | null;
  head: string;
  destination?: GitDestination;
  source?: GitDestination;
  /** Captured local branch configuration for validating a rename or deletion. */
  sourceConfigSignature?: string;
  unmergedCommits?: number;
  remoteDeletion?: GitDestination;
  createTracking?: boolean;
  /** Push only: commits on the destination that the local branch lacks. */
  incoming?: number;
  /** Push only: local commits missing from a destination with incoming history. */
  outgoing?: number;
  noop: boolean;
  blockers: string[];
  warnings: string[];
}

export interface GitActionPreview {
  id: string;
  projectId: string;
  action: GitAction;
  rows: GitActionRow[];
  ready: boolean;
  /** Display-only, server-confirmed counterparts for optional local+remote deletion. */
  remoteDeletionCandidates?: Record<string, GitDestination[]>;
}

export interface GitOperation {
  id: string;
  projectId: string;
  action: GitAction;
  state: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  rows: (GitActionRow & {
    state: 'pending' | 'running' | 'done' | 'failed' | 'unknown';
    message?: string;
  })[];
}

export interface GitWorkflowSnapshot {
  projectId: string;
  version?: number;
  cached?: boolean;
  loading?: boolean;
  pendingRepositories?: string[];
  repositories: GitRepositoryStatus[];
  branches: GitProjectBranch[];
  operation?: GitOperation;
}

export interface GitWorkflowProgress {
  stage: 'fetching' | 'checking';
  done: number;
  total: number;
}

export interface GitWorkflowChange {
  projectId: string;
  activity?: 'fetch' | 'preview' | 'mutation';
  busy: boolean;
  progress?: GitWorkflowProgress;
  snapshot?: GitWorkflowSnapshot;
  operation?: GitOperation;
}

export interface GitWorkflowAPI {
  getGitHistory(projectId: string, input: GitHistoryInput): Promise<GitHistory>;
  getGitProjectHistory(
    projectId: string,
    input: Omit<GitHistoryInput, 'repositoryPath'>,
  ): Promise<GitProjectHistory>;
  getCachedGitStatus(projectId: string): Promise<GitWorkflowSnapshot | undefined>;
  getGitStatus(projectId: string): Promise<GitWorkflowSnapshot>;
  fetchGit(projectId: string): Promise<GitWorkflowSnapshot>;
  previewGitAction(projectId: string, input: GitActionInput): Promise<GitActionPreview>;
  runGitAction(projectId: string, previewId: string): Promise<GitOperation>;
  acknowledgeGitOperation(projectId: string): Promise<GitWorkflowSnapshot>;
  onGitWorkflowChanged(callback: (change: GitWorkflowChange) => void): () => void;
}

export interface GitHistoryInput {
  repositoryPath: string;
  /** Omit to show every local branch, remote branch and tag, plus detached HEAD. */
  branch?: GitBranchChoice;
  limit?: number;
}

export interface GitCommitRef {
  name: string;
  kind: 'local' | 'remote' | 'tag' | 'head';
}

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  refs: GitCommitRef[];
  committedAt?: string;
}

export interface GitHistory {
  repositoryPath: string;
  commits: GitCommit[];
  hasMore: boolean;
}

export interface GitTimelineEntry {
  repositoryPath: string;
  commit: GitCommit;
  association: 'anchor';
}
export interface GitTimelineEvent {
  id: string;
  entries: GitTimelineEntry[];
}
export interface GitProjectHistory {
  events: GitTimelineEvent[];
  repositories: { path: string; error?: string }[];
  hasMore: boolean;
}
