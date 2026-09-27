/** Account changes and native Jira window changes must finish in submission order. */
export class JiraBrowserOperations {
  private pending: Promise<unknown> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  idle(): Promise<unknown> {
    return this.pending;
  }
}
