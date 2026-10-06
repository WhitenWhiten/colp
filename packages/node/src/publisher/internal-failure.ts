export type PublisherInternalFailureOperation =
  | 'guarded-node-write'
  | 'ordinary-node-create'
  | 'node-move'
  | 'node-delete';

export type PublisherInternalFailureObservation = {
  readonly operation: PublisherInternalFailureOperation;
  readonly code: 'internal_error';
  readonly cause: unknown;
};

export type PublisherInternalFailureObserver = (
  observation: PublisherInternalFailureObservation,
) => void | Promise<void>;

/**
 * Best-effort host observation. Observer throws/rejections must never change the
 * coordinator's internal_error wire outcome.
 */
export async function notifyPublisherInternalFailure(
  observer: PublisherInternalFailureObserver | undefined,
  operation: PublisherInternalFailureOperation,
  cause: unknown,
): Promise<void> {
  if (typeof observer !== 'function') return;
  try {
    await observer(Object.freeze({
      operation,
      code: 'internal_error' as const,
      cause,
    }));
  } catch {
    // best-effort only
  }
}

/**
 * Read an optional observer from an untrusted ports container without letting
 * a Proxy or accessor failure escape the coordinator's internal_error path.
 */
export async function notifyPublisherInternalFailureFromPorts(
  ports: unknown,
  operation: PublisherInternalFailureOperation,
  cause: unknown,
): Promise<void> {
  let observer: PublisherInternalFailureObserver | undefined;
  try {
    if (ports !== null && typeof ports === 'object') {
      const candidate = (ports as { readonly onInternalFailure?: unknown }).onInternalFailure;
      observer = typeof candidate === 'function'
        ? candidate as PublisherInternalFailureObserver
        : undefined;
    }
  } catch {
    return;
  }
  await notifyPublisherInternalFailure(observer, operation, cause);
}
