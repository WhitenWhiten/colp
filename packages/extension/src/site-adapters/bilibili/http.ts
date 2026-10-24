import type { ReadFailure } from '../contracts.js';
import { LIMITS as L } from '../limits.js';
import { decimal } from './identity.js';
export class SiteReadError extends Error {
  constructor(readonly failure: ReadFailure) { super(failure.code); }
}
export function fail(code: ReadFailure['code'], retryAfterMs?: number): never {
  throw new SiteReadError({ code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
};
export type Operation = { kind: 'account' } | { kind: 'collections'; accountId: string }
  | { kind: 'ids'; collectionId: string; page: number } | { kind: 'details'; ids: readonly { id: string; type: number }[] };
export function operationUrl(op: Operation): string {
  if (!['account', 'collections', 'ids', 'details'].includes(op.kind)) fail('invalidData');
  const url = new URL('https://api.bilibili.com');
  if (op.kind === 'account') url.pathname = '/x/web-interface/nav';
  if (op.kind === 'collections') {
    if (!decimal(op.accountId)) fail('invalidData');
    url.pathname = '/x/v3/fav/folder/created/list-all'; url.searchParams.set('up_mid', op.accountId);
  }
  if (op.kind === 'ids') {
    if (!decimal(op.collectionId) || !Number.isInteger(op.page) || op.page < 1 || op.page > L.idPages) fail('invalidData');
    url.pathname = '/x/v3/fav/resource/ids'; url.searchParams.set('media_id', op.collectionId);
    url.searchParams.set('pn', String(op.page)); url.searchParams.set('ps', String(L.idsPerApiPage));
  }
  if (op.kind === 'details') {
    if (!op.ids.length || op.ids.length > L.detailsPerRequest || op.ids.some(x => !decimal(x.id) || x.type !== 2)) fail('invalidData');
    url.pathname = '/x/v3/fav/resource/infos'; url.searchParams.set('resources', op.ids.map(x => `${x.id}:${x.type}`).join(','));
  }
  return url.href;
}
export async function boundedJson(response: Response, maxBytes: number = L.responseBytes): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) return fail('invalidData');
  let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > maxBytes) fail('capacity'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const all = new Uint8Array(bytes); let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { return fail('invalidData'); }
}
export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function retryAfter(value: string | null, now: number): number {
  if (value && /^\d+(\.\d+)?$/u.test(value.trim())) return Math.ceil(Number(value) * 1000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date >= now ? date - now : L.backoffMs;
}
export interface HttpContext { signal: AbortSignal; deadlineAt: number }
export function createPageHttp(deps: { fetch: typeof fetch; now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }) {
  let nextAt = 0;
  return async (op: Operation, ctx: HttpContext): Promise<unknown> => {
    const url = operationUrl(op);
    for (let attempt = 0; attempt < L.attempts; attempt++) {
      if (ctx.signal.aborted) fail('cancelled');
      const wait = Math.max(0, nextAt - deps.now());
      if (deps.now() + wait >= ctx.deadlineAt) fail('timeout');
      if (wait) await deps.sleep(wait, ctx.signal);
      const remaining = ctx.deadlineAt - deps.now(); if (remaining <= 0) fail('timeout');
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(L.requestMs, remaining))]);
      let response: Response;
      try { response = await deps.fetch.call(globalThis, url, { method: 'GET', credentials: 'include', redirect: 'error', signal }); }
      catch {
        nextAt = deps.now() + L.spacingMs;
        if (ctx.signal.aborted) fail('cancelled');
        if (signal.aborted) fail('timeout');
        if (attempt + 1 === L.attempts) fail('network');
        await retry(L.backoffMs); continue;
      }
      nextAt = deps.now() + L.spacingMs;
      if (response.status === 412) { await response.body?.cancel(); fail('challenge'); }
      if (response.status === 429 || response.status >= 500) {
        const waitMs = response.status === 429 ? retryAfter(response.headers.get('Retry-After'), deps.now()) : L.backoffMs;
        await response.body?.cancel();
        if (attempt + 1 === L.attempts || waitMs > L.maxAutomaticWaitMs || deps.now() + waitMs + L.requestMs > ctx.deadlineAt)
          fail(response.status === 429 ? 'rateLimited' : 'network', waitMs);
        await retry(waitMs); continue;
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('signedOut'); }
      if (!response.ok) { await response.body?.cancel(); fail('invalidData'); }
      const body = record(await boundedJson(response));
      if (body.code === -101) fail('signedOut');
      if (body.code === -412) fail('challenge');
      if (body.code !== 0) fail('invalidData');
      return body.data;
      async function retry(ms: number) {
        if (deps.now() + ms >= ctx.deadlineAt) fail('timeout');
        await deps.sleep(ms, ctx.signal);
      }
    }
    return fail('network');
  };
}
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SiteReadError({ code: 'cancelled' })); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new SiteReadError({ code: 'cancelled' })); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', abort, { once: true });
  });
}
