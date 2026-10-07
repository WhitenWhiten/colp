import { settleBestEffort } from '../async/best-effort.js';

/** Dispose inside the transaction, before its connection can be reused. */
export function installTransactionCancellation(
  signal: AbortSignal,
  cancelBackend: () => Promise<unknown>,
): () => Promise<void> {
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= settleBestEffort(Promise.resolve().then(cancelBackend),
      'the transaction AbortSignal reason is authoritative over backend cancellation failure');
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return async () => {
    signal.removeEventListener('abort', cancel);
    await cancellation;
  };
}
