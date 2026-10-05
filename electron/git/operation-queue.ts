import path from 'node:path';

const overlaps = (a: string, b: string): boolean => {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  return contains(a, b) || contains(b, a);
};

/** Readers coexist. Writes protect both checkouts and shared Git directories. */
export class GitOperationQueue {
  private pending = new Set<{
    write: boolean;
    scope: Promise<string[]> | undefined;
    done: Promise<unknown>;
  }>();

  run<T>(write: boolean, scope: Promise<string[]> | undefined, action: () => Promise<T>): Promise<T> {
    const previous = [...this.pending].filter((entry) => write || entry.write);
    const done = (async () => {
      const resources = await scope;
      await Promise.all(
        previous.map(async (entry) => {
          const other = await entry.scope?.catch(() => undefined);
          if (!resources || !other || resources.some((a) => other.some((b) => overlaps(a, b))))
            await entry.done.catch(() => {});
        }),
      );
      return action();
    })();
    const entry = { write, scope, done };
    this.pending.add(entry);
    const cleanup = () => this.pending.delete(entry);
    void done.then(cleanup, cleanup);
    return done;
  }
}
