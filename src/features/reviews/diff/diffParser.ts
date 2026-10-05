import type { DiffFileInput, FileDiffMetadata } from '@pierre/diffs';
import ParseWorker from './parseDiff.worker?worker';

const cache = new Map<string, { diff: FileDiffMetadata; size: number }>();
const pending = new Map<
  string,
  {
    resolve: (diff: FileDiffMetadata) => void;
    reject: (error: Error) => void;
    promise: Promise<FileDiffMetadata>;
    size: number;
  }
>();
let worker: Worker | undefined;
let cacheSize = 0;

/** Parse off the UI thread, share in-flight work and retain a bounded version cache. */
export function parseReviewDiff(key: string, files: DiffFileInput): Promise<FileDiffMetadata> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.diff);
  }
  const existing = pending.get(key);
  if (existing) return existing.promise;
  if (!worker) {
    worker = new ParseWorker();
    worker.onmessage = (event: MessageEvent<{ key: string; diff?: FileDiffMetadata; error?: string }>) => {
      const entry = pending.get(event.data.key);
      if (!entry) return;
      pending.delete(event.data.key);
      const { diff, error } = event.data;
      if (!diff) {
        entry.reject(new Error(error || 'Unable to parse this diff.'));
        return;
      }
      // Source bytes approximate cache weight; the count also bounds AST overhead.
      while (cache.size && (cache.size >= 12 || cacheSize + entry.size > 24 * 1024 * 1024)) {
        const oldest = cache.keys().next().value!;
        cacheSize -= cache.get(oldest)!.size;
        cache.delete(oldest);
      }
      if (entry.size <= 24 * 1024 * 1024) {
        cache.set(event.data.key, { diff, size: entry.size });
        cacheSize += entry.size;
      }
      entry.resolve(diff);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = undefined;
      for (const entry of pending.values())
        entry.reject(new Error('The diff worker stopped. Reopen the file to retry.'));
      pending.clear();
    };
  }
  let resolve!: (diff: FileDiffMetadata) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FileDiffMetadata>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  pending.set(key, {
    resolve,
    reject,
    promise,
    size: 2 * ((files.oldFile?.contents.length ?? 0) + (files.newFile?.contents.length ?? 0)),
  });
  worker.postMessage({ key, files });
  return promise;
}
