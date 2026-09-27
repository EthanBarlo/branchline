import { createMemoryHistory, type HistoryLocation, type RouterHistory } from '@tanstack/react-router';

type MemoryHistoryOptions = NonNullable<Parameters<typeof createMemoryHistory>[0]>;
type NavigationBlocker = Parameters<RouterHistory['block']>[0];
type NavigationOptions = Parameters<RouterHistory['back']>[0];
type NavigationAction = Parameters<NavigationBlocker['blockerFn']>[0]['action'];
type WorkspaceHistoryOptions = MemoryHistoryOptions & { onBlocked?: () => void };

// TanStack's memory history currently checks blockers only for push and replace.
// Keep its history/state behavior while guarding every way to change entries.
export function createWorkspaceHistory(
  options: WorkspaceHistoryOptions = { initialEntries: ['/'] },
): RouterHistory {
  const initialEntries = options.initialEntries.length ? options.initialEntries : ['/'];
  const memory = createMemoryHistory({ initialEntries: [initialEntries[0]] });
  const entries: HistoryLocation[] = [memory.location];
  for (const entry of initialEntries.slice(1)) {
    memory.push(entry, undefined, { ignoreBlocker: true });
    entries.push(memory.location);
  }
  const initialIndex = Math.min(
    Math.max(Math.trunc(options.initialIndex ?? entries.length - 1), 0),
    entries.length - 1,
  );
  memory.go(initialIndex - entries.length + 1, { ignoreBlocker: true });

  const subscribers: RouterHistory['subscribers'] = new Set();
  const blockers = new Set<NavigationBlocker>();
  let generation = 0;
  let destroyed = false;
  const unsubscribe = memory.subscribe(({ location, action }) => {
    const index = location.state.__TSR_index;
    if (action.type === 'PUSH') entries.splice(index, entries.length - index, location);
    else if (action.type === 'REPLACE') entries[index] = location;
    for (const subscriber of subscribers) subscriber({ location, action });
  });

  function navigate(
    action: NavigationAction,
    nextLocation: HistoryLocation,
    commit: () => void,
    navigationOptions?: NavigationOptions,
  ) {
    const attempt = ++generation;
    if (destroyed) return;
    if (navigationOptions?.ignoreBlocker || !blockers.size) {
      commit();
      return;
    }
    const currentLocation = memory.location;
    void (async () => {
      try {
        for (const blocker of [...blockers]) {
          const blocked = await blocker.blockerFn({ currentLocation, nextLocation, action });
          if (attempt !== generation) return;
          if (blocked) {
            options.onBlocked?.();
            return;
          }
        }
      } catch {
        if (attempt === generation) options.onBlocked?.();
        return;
      }
      if (attempt === generation) commit();
    })();
  }

  function preview(path: string, state: unknown, index: number): HistoryLocation {
    const location = createMemoryHistory({ initialEntries: [path] }).location;
    return {
      ...location,
      state: { ...Object(state), ...location.state, __TSR_index: index },
    };
  }

  function traverse(action: 'BACK' | 'FORWARD' | 'GO', offset: number, opts?: NavigationOptions) {
    const index = memory.location.state.__TSR_index;
    const target = Math.min(Math.max(index + offset, 0), entries.length - 1);
    navigate(
      action,
      entries[target],
      () => {
        if (action === 'BACK') memory.back({ ignoreBlocker: true });
        else if (action === 'FORWARD') memory.forward({ ignoreBlocker: true });
        else memory.go(offset, { ignoreBlocker: true });
      },
      opts,
    );
  }

  return {
    get location() {
      return memory.location;
    },
    get length() {
      return memory.length;
    },
    subscribers,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    push: (path, state, opts) =>
      navigate(
        'PUSH',
        preview(path, state, memory.location.state.__TSR_index + 1),
        () => memory.push(path, state, { ignoreBlocker: true }),
        opts,
      ),
    replace: (path, state, opts) =>
      navigate(
        'REPLACE',
        preview(path, state, memory.location.state.__TSR_index),
        () => memory.replace(path, state, { ignoreBlocker: true }),
        opts,
      ),
    back: (opts) => traverse('BACK', -1, opts),
    forward: (opts) => traverse('FORWARD', 1, opts),
    go: (offset, opts) => traverse('GO', Math.trunc(offset), opts),
    canGoBack: () => memory.canGoBack(),
    createHref: (href) => memory.createHref(href),
    block: (blocker) => {
      blockers.add(blocker);
      return () => {
        blockers.delete(blocker);
      };
    },
    flush: () => memory.flush(),
    notify: (action) => memory.notify(action),
    destroy: () => {
      destroyed = true;
      generation++;
      unsubscribe();
      blockers.clear();
      subscribers.clear();
      memory.destroy();
    },
    _getBlockers: () => [...blockers],
  };
}
