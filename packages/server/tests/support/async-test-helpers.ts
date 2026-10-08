import { setTimeout as sleep } from 'node:timers/promises';

export interface WaitForConditionOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly description: string;
}

export interface RealTimeWaitOptions {
  readonly signal?: AbortSignal;
}

/** Yield until the next event-loop turn without imposing a wall-clock delay. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Wait for an observable state transition. Most in-process tests should use
 * the default event-loop yield; external systems may opt into a small polling
 * interval so the test does not hammer PostgreSQL/Redis while it waits.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options: WaitForConditionOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 0;
  if (!options.description.trim()) throw new Error('waitForCondition requires a description');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('waitForCondition timeoutMs must be positive');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('waitForCondition pollIntervalMs must be non-negative');
  }

  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await condition()) return;
    if (pollIntervalMs > 0) await sleep(pollIntervalMs);
    else await yieldToEventLoop();
  }
  throw new Error(`Timed out waiting for ${options.description} after ${timeoutMs}ms`);
}

/**
 * Deliberate real-time passage for tests whose subject is time itself (TTL,
 * timeout, retry cadence, or transport backpressure). The required reason
 * keeps such waits reviewable and distinct from synchronization sleeps.
 */
export async function waitForRealTime(
  milliseconds: number,
  reason: string,
  options: RealTimeWaitOptions = {},
): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error('waitForRealTime milliseconds must be non-negative');
  }
  if (!reason.trim()) throw new Error('waitForRealTime requires a reason');
  await sleep(milliseconds, undefined, options.signal === undefined ? {} : { signal: options.signal });
}

/**
 * Bounds an asynchronous operation with a cancellable real-time watchdog.
 * Successful operations abort the losing timer so it cannot keep the test
 * process alive after the assertion has completed.
 */
export async function withRealTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!message.trim()) throw new Error('withRealTimeout requires a message');
  const controller = new AbortController();
  const timeout = waitForRealTime(
    timeoutMs,
    `watchdog for ${message}`,
    { signal: controller.signal },
  ).then<never>(() => {
    throw new Error(message);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    controller.abort();
  }
}
