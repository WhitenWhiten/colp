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
