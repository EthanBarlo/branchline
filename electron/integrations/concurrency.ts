/** Keep results in input order, stop scheduling after failure, and drain started work. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  action: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer.');
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          results[index] = await action(values[index], index);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

/** Share `limit` slots between actions that start at different times, in arrival order. */
export function concurrencyLimit(limit: number): <R>(action: () => Promise<R>) => Promise<R> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer.');
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (action) => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await action();
    } finally {
      // Hand the slot straight to the next waiter so a newcomer cannot overtake it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
