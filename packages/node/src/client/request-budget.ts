/** Bounds one public method invocation, including discovery and every redirect. */
export interface ClientRequestLimits {
  readonly timeoutMs: number;
  /** Maximum bytes per response body, including Manifest and Problem bodies. */
  readonly maxBytes: number;
}

export interface ClientRequestOptions extends Partial<ClientRequestLimits> {
  readonly signal?: AbortSignal;
}

export const defaultClientRequestLimits: ClientRequestLimits = Object.freeze({
  timeoutMs: 30_000,
  maxBytes: 64 * 1024 * 1024,
});

export class ColpClientLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ColpClientLimitError';
  }
}

export interface RequestBudget {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export function resolveClientRequestLimits(
  options: Partial<ClientRequestLimits> = {},
  defaults: ClientRequestLimits = defaultClientRequestLimits,
): ClientRequestLimits {
  const limits = { timeoutMs: options.timeoutMs ?? defaults.timeoutMs, maxBytes: options.maxBytes ?? defaults.maxBytes };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError('requestLimits.' + name + ' must be a positive safe integer.');
    }
  }
  return Object.freeze(limits);
}

/** Detaches listeners when either side settles, even for an uncooperative port. */
export function abortable<Value>(promise: Promise<Value>, signal: AbortSignal | undefined): Promise<Value> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export async function withRequestBudget<Value>(
  defaults: ClientRequestLimits,
  options: ClientRequestOptions,
  work: (budget: RequestBudget) => Promise<Value>,
  timeoutCeiling?: number,
): Promise<Value> {
  const limits = resolveClientRequestLimits(options, defaults);
  const callerSignal = options.signal;
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timeoutMs = Math.min(limits.timeoutMs, timeoutCeiling ?? limits.timeoutMs);
  const timeoutError = new ColpClientLimitError('Request exceeded the timeout of ' + timeoutMs + ' ms.');
  let remaining = timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  // Node clamps longer timers to 1 ms. Schedule long budgets in supported chunks.
  const schedule = (): void => {
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      remaining -= delay;
      if (remaining > 0) schedule();
      else controller.abort(timeoutError);
    }, delay);
  };
  schedule();
  try {
    const result = await work({ signal: controller.signal, maxBytes: limits.maxBytes });
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer!);
    callerSignal?.removeEventListener('abort', onAbort);
  }
}
