/** Tracks whole IPC operations, including Git work that precedes a store write. */
export class InstallGate {
  private phase: 'open' | 'flushing' | 'sealed' = 'open';
  private pending = new Set<Promise<unknown>>();
  private failure: unknown;
  private generation = 0;

  run<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.phase === 'sealed' || (this.phase === 'flushing' && !name.startsWith('comment-'))) {
      return Promise.reject(new Error('Branchline is preparing to update. Try again after the update finishes.'));
    }
    const request = Promise.resolve().then(operation);
    this.pending.add(request);
    void request.then(() => this.pending.delete(request), error => {
      this.pending.delete(request);
      if (this.phase !== 'open') this.failure = error;
    });
    return request;
  }

  async prepare(flush: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
    if (this.phase !== 'open') throw new Error('An update is already being installed.');
    this.phase = 'flushing';
    this.failure = undefined;
    const generation = ++this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const assertActive = () => {
      if (generation !== this.generation) throw new Error('Update preparation was cancelled.');
    };
    try {
      await Promise.race([
        (async () => {
          await flush();
          assertActive();
          this.phase = 'sealed';
          await Promise.allSettled([...this.pending]);
          assertActive();
          if (this.failure !== undefined) throw this.failure;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Saving took too long. Your workspace is still open; try the update again.')), timeoutMs);
        }),
      ]);
    } catch (error) {
      this.reset();
      throw error;
    } finally { clearTimeout(timer); }
  }

  reset(): void { this.phase = 'open'; this.failure = undefined; this.generation++; }
}
