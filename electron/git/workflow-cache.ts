import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitWorkflowSnapshot } from '../../shared/git-workflow';
import type { Project } from '../../shared/types';

/** Display-only cache. Mutation preflights always read Git again. */
export class GitWorkflowCache {
  private entries: Record<string, { root: string; snapshot: GitWorkflowSnapshot }> = {};
  private saving: Promise<void> = Promise.resolve();
  constructor(private filename: string) {}
  async load(): Promise<void> {
    try {
      const entries = JSON.parse(await readFile(this.filename, 'utf8'));
      if (entries && typeof entries === 'object') this.entries = entries;
    } catch {
      /* A missing or damaged display cache is rebuilt from Git. */
    }
  }
  get(project: Project): GitWorkflowSnapshot | undefined {
    const entry = this.entries[project.id];
    if (
      entry?.root !== path.resolve(project.repoPath) ||
      !Array.isArray(entry.snapshot?.branches) ||
      !Array.isArray(entry.snapshot?.repositories)
    )
      return undefined;
    return {
      ...structuredClone(entry.snapshot),
      version: 0,
      cached: true,
      loading: true,
      pendingRepositories: [
        ...new Set([
          '.',
          ...(entry.snapshot.pendingRepositories ?? []),
          ...entry.snapshot.repositories.map((repo) => repo.path),
        ]),
      ],
    };
  }
  put(project: Project, snapshot: GitWorkflowSnapshot): Promise<void> {
    this.entries[project.id] = { root: path.resolve(project.repoPath), snapshot: structuredClone(snapshot) };
    const saved = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.filename), { recursive: true });
        const temporary = `${this.filename}.tmp`;
        await writeFile(temporary, JSON.stringify(this.entries), { mode: 0o600 });
        await rename(temporary, this.filename);
      });
    this.saving = saved;
    return saved;
  }
}
