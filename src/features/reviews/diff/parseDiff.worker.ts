import type { DiffFileInput } from '@pierre/diffs';
import { parseReviewFilePair } from './diffParsing';

self.onmessage = (event: MessageEvent<{ key: string; files: DiffFileInput }>) => {
  const { key, files } = event.data;
  try {
    self.postMessage({ key, diff: parseReviewFilePair(files) });
  } catch (error) {
    self.postMessage({ key, error: error instanceof Error ? error.message : String(error) });
  }
};
