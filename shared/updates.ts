export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'preparing' | 'installing';
export type UpdateAction = 'check' | 'download' | 'install';

export interface UpdateState {
  revision: number;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string;
  progress: number | null;
  lastCheckedAt: number | null;
  disabledReason: string | null;
  error: { action: UpdateAction; message: string } | null;
}

export const updatesBusy = (state: UpdateState | null): boolean => state?.phase === 'preparing' || state?.phase === 'installing';

export interface UpdateAPI {
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  onUpdateStateChanged(callback: (state: UpdateState) => void): () => void;
  onUpdateDialogRequested(callback: () => void): () => void;
}
