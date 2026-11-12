/// <reference lib="webworker" />
import { runBatch, type BatchProgress, type BatchRequest } from '../sim/batch';

export type BatchWorkerMessage =
  | { type: 'progress'; progress: BatchProgress }
  | { type: 'done'; result: ReturnType<typeof runBatch> }
  | { type: 'error'; message: string };

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<BatchRequest>) => {
  try {
    const result = runBatch(event.data, (progress) => {
      worker.postMessage({ type: 'progress', progress } satisfies BatchWorkerMessage);
    });
    worker.postMessage({ type: 'done', result } satisfies BatchWorkerMessage);
  } catch (error) {
    worker.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '批量推演失败',
    } satisfies BatchWorkerMessage);
  }
};
