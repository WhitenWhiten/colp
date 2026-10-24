import type { ReadFailure } from './contracts.js';
export class SiteReadError extends Error {
  constructor(readonly failure: ReadFailure) { super(failure.code); }
}
export function fail(code: ReadFailure['code'], retryAfterMs?: number): never {
  throw new SiteReadError({ code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
};
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SiteReadError({ code: 'cancelled' })); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new SiteReadError({ code: 'cancelled' })); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', abort, { once: true });
  });
}

/** Enforce host deadlines even when an adapter ignores its cancellation signal. */
export function withReadDeadline<T>(work: () => Promise<T>, context: { signal: AbortSignal; deadlineAt: number }): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value: T } | { error: unknown }) => {
      clearTimeout(timer); context.signal.removeEventListener('abort', abort);
      if ('error' in result) reject(result.error); else resolve(result.value);
    };
    const abort = () => finish({ error: new SiteReadError({ code: Date.now() >= context.deadlineAt ? 'timeout' : 'cancelled' }) });
    if (context.signal.aborted || context.deadlineAt <= Date.now()) { abort(); return; }
    context.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish({ error: new SiteReadError({ code: 'timeout' }) }), context.deadlineAt - Date.now());
    Promise.resolve().then(work).then(value => finish({ value }), error => finish({ error }));
  });
}
