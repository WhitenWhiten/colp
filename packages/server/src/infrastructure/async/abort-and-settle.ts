import { settleBestEffort } from './best-effort.js';

export async function withAbort<Value>(operation: Promise<Value>, signal: AbortSignal | undefined,
  cancel: () => Promise<void>): Promise<Value> {
  if (!signal) return operation;
  const completed = operation.then(
    (value) => ({ completed: true as const, value }),
    (error: unknown) => ({ completed: true as const, error }),
  );
  // Definite-assignment assertion for the resolver that the withAbort race awaits.
  let notifyAbort!: () => void;
  const aborted = new Promise<{ readonly completed: false }>((resolve) => {
    notifyAbort = () => resolve({ completed: false });
    signal.addEventListener('abort', notifyAbort, { once: true });
  });
  // The operation is already running. Even a signal aborted before entry must
  // cancel and join it before its caller can roll back the transaction.
  const outcome = signal.aborted ? { completed: false as const } : await Promise.race([completed, aborted]);
  signal.removeEventListener('abort', notifyAbort);
  if (outcome.completed) {
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
  await settleBestEffort(Promise.resolve().then(cancel), 'the Sync Pull AbortSignal reason is authoritative over cancellation failure');
  await settleBestEffort(operation, 'the Sync Pull AbortSignal reason is authoritative over the cancelled query rejection');
  throw reason;
}

