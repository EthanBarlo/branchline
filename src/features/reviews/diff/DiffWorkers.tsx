import { WorkerPoolContextProvider, type WorkerPoolOptions } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';

const poolOptions: WorkerPoolOptions = {
  poolSize: Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)),
  totalASTLRUCacheSize: 100,
  workerFactory: () => new DiffWorker(),
};
const highlighterOptions = {
  theme: { light: 'pierre-light', dark: 'pierre-dark' } as const,
};

export function DiffWorkers({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
