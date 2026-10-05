export type GitAction = 'checkout' | 'pull' | 'push' | 'create' | 'rename';

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
}

export interface GitActionRow {
  path: string;
  branch: string | null;
  head: string;
  destination?: GitDestination;
  source?: GitDestination;
  /** Captured branch configuration for safely reconciling a rename. */
  sourceConfigSignature?: string;
  createTracking?: boolean;
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

export interface GitWorkflowChange {
  projectId: string;
  busy: boolean;
  snapshot?: GitWorkflowSnapshot;
  operation?: GitOperation;
}

export interface GitWorkflowAPI {
  getCachedGitStatus(projectId: string): Promise<GitWorkflowSnapshot | undefined>;
  getGitStatus(projectId: string): Promise<GitWorkflowSnapshot>;
  fetchGit(projectId: string): Promise<GitWorkflowSnapshot>;
  previewGitAction(projectId: string, input: GitActionInput): Promise<GitActionPreview>;
  runGitAction(projectId: string, previewId: string): Promise<GitOperation>;
  acknowledgeGitOperation(projectId: string): Promise<GitWorkflowSnapshot>;
  onGitWorkflowChanged(callback: (change: GitWorkflowChange) => void): () => void;
}
