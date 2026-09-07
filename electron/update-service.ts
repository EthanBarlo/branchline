import type { EventEmitter } from 'node:events';
import type { UpdateAction, UpdateState } from '../shared/updates';

export interface ReleaseInfo { version: string; releaseNotes?: string | Array<{ version: string; note: string | null }> | null }
export interface UpdaterPort extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
}
interface UpdateOptions {
  version: string;
  disabledReason?: string;
  updater?: UpdaterPort;
  prepare: () => Promise<void>;
  install: () => Promise<void>;
  release: () => void;
  log?: (message: string) => void;
  now?: () => number;
}
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

/** GitHub's Atom feed supplies HTML. Return plain text, never renderer markup. */
export function releaseNotesToText(notes: string): string {
  return notes.slice(0, 30_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key] || '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function newerStable(candidate: string, current: string): boolean {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!pattern.test(candidate) || !pattern.test(current)) return false;
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

export class UpdateService {
  private state: UpdateState;
  private listeners = new Set<(state: UpdateState) => void>();
  private cleanup: Array<() => void> = [];
  private startTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private operation?: Promise<UpdateState>;
  private activeAction?: UpdateAction;

  constructor(private options: UpdateOptions) {
    this.state = { revision: 0, phase: options.disabledReason || !options.updater ? 'disabled' : 'idle',
      currentVersion: options.version, availableVersion: null, releaseNotes: '', progress: null,
      lastCheckedAt: null, disabledReason: options.disabledReason ?? null, error: null };
    const updater = options.updater;
    if (!updater || this.state.phase === 'disabled') return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    const on = (name: string, listener: (...args: any[]) => void) => {
      updater.on(name, listener);
      this.cleanup.push(() => updater.removeListener(name, listener));
    };
    on('update-available', (info: ReleaseInfo) => {
      if (this.activeAction !== 'check' || this.state.phase !== 'checking') return;
      if (!newerStable(info.version, this.state.currentVersion)) { this.noUpdate(); return; }
      const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map(note => `${note.version}\n${note.note || ''}`).join('\n\n') : info.releaseNotes || '';
      this.set({ phase: 'available', availableVersion: info.version, releaseNotes: releaseNotesToText(notes), error: null });
    });
    on('update-not-available', () => { if (this.activeAction === 'check' && this.state.phase === 'checking') this.noUpdate(); });
    on('download-progress', (progress: { percent: number }) => {
      if (this.state.phase === 'downloading' && Number.isFinite(progress.percent)) this.set({ progress: Math.max(0, Math.min(100, progress.percent)) });
    });
    on('update-downloaded', (info: ReleaseInfo) => {
      if (this.activeAction === 'download' && this.state.phase === 'downloading' && info.version === this.state.availableVersion) this.set({ phase: 'downloaded', progress: 100, error: null });
    });
    // Native staging errors are handled by the install adapter before restoring editing.
    on('error', (error: Error) => { if (this.activeAction && this.activeAction !== 'install') this.fail(this.activeAction, error); });
  }

  getState = (): UpdateState => structuredClone(this.state);
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(changes: Partial<UpdateState>) {
    const previous = this.state;
    this.state = { ...previous, ...changes, revision: previous.revision + 1 };
    if (previous.phase !== this.state.phase || changes.error) this.options.log?.(`Updater: ${this.state.phase}${changes.error ? ` (${changes.error.action}: ${changes.error.message})` : ''}`);
    for (const listener of this.listeners) listener(this.getState());
  }
  private noUpdate() { this.set({ phase: 'idle', availableVersion: null, releaseNotes: '', progress: null, error: null }); }
  private fail(action: UpdateAction, error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = /read.only|permission|EACCES|EROFS|AppTranslocation|disk image/i.test(raw)
      ? 'Move Branchline to your Applications folder, open it there, and try again.'
      : /signature|codesign|checksum|sha512/i.test(raw)
        ? 'The update could not be verified. Download it again or try a later release.'
        : action === 'check' ? 'Could not check for updates. Check your connection and try again.'
          : action === 'download' ? 'The download did not finish. Check your connection and available disk space, then retry.'
            : `Could not restart to update. ${raw}`;
    this.set({ phase: action === 'install' ? 'downloaded' : action === 'download' && this.state.availableVersion ? 'available' : 'idle',
      progress: action === 'install' ? 100 : null, error: { action, message } });
  }
  private perform(action: UpdateAction, work: () => Promise<void>): Promise<UpdateState> {
    if (this.operation) return this.operation;
    this.activeAction = action;
    this.operation = Promise.resolve().then(work).catch(error => {
      if (action === 'install') this.options.release();
      this.fail(action, error);
    }).then(() => this.getState()).finally(() => { this.operation = undefined; this.activeAction = undefined; });
    return this.operation;
  }
  check = (): Promise<UpdateState> => {
    if (this.operation) return this.operation;
    if (!['idle', 'available'].includes(this.state.phase)) return Promise.resolve(this.getState());
    this.set({ phase: 'checking', error: null, lastCheckedAt: (this.options.now || Date.now)() });
    return this.perform('check', async () => {
      await this.options.updater!.checkForUpdates();
      if (this.state.phase === 'checking') throw new Error('The update server did not return a release.');
    });
  };
  download = (): Promise<UpdateState> => {
    if (this.operation) return this.operation;
    if (this.state.phase !== 'available' && this.state.phase !== 'downloaded') return Promise.resolve(this.getState());
    this.set({ phase: 'downloading', progress: 0, error: null });
    return this.perform('download', async () => {
      await this.options.updater!.downloadUpdate();
      if (this.state.phase === 'downloading') throw new Error('The update download was incomplete.');
    });
  };
  install = (): Promise<UpdateState> => {
    if (this.operation) return this.operation;
    if (this.state.phase !== 'downloaded') return Promise.resolve(this.getState());
    this.set({ phase: 'preparing', error: null });
    return this.perform('install', async () => {
      await this.options.prepare();
      this.set({ phase: 'installing' });
      await this.options.install();
    });
  };
  checkIfDue = (): void => {
    if (this.state.lastCheckedAt === null || (this.options.now || Date.now)() - this.state.lastCheckedAt >= UPDATE_INTERVAL) void this.check();
  };
  start(): void {
    if (this.state.phase === 'disabled' || this.startTimer || this.interval) return;
    this.startTimer = setTimeout(this.checkIfDue, 10_000);
    this.interval = setInterval(this.checkIfDue, UPDATE_INTERVAL);
    this.startTimer.unref(); this.interval.unref();
  }
  dispose(): void {
    clearTimeout(this.startTimer); clearInterval(this.interval);
    this.cleanup.forEach(dispose => dispose()); this.listeners.clear();
  }
}
