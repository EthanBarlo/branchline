/** Keep results in input order, stop scheduling after failure, and drain started work. */
export async function mapConcurrent<T, R>(values: readonly T[], limit: number, action: (value: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer.');
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await action(values[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
