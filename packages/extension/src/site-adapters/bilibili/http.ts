import { readLimits, type SiteReadPolicy } from '../read-policy.js';
import { LIMITS as L } from '../limits.js';
import { decimal } from './identity.js';
import { fail, SiteReadError } from '../read-errors.js';
export { SiteReadError, abortableSleep, fail } from '../read-errors.js';
export type Operation = { kind: 'video'; bvid: string } | { kind: 'account' } | { kind: 'collections'; accountId: string }
  | { kind: 'ids'; collectionId: string; page: number } | { kind: 'details'; ids: readonly { id: string; type: number }[] };
export function operationUrl(op: Operation): string {
  if (!['account', 'collections', 'ids', 'details', 'video'].includes(op.kind)) fail('invalidData');
  const url = new URL('https://api.bilibili.com');
  if (op.kind === 'video') {
    if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/u.test(op.bvid)) fail('invalidData');
    url.pathname = '/x/web-interface/view'; url.searchParams.set('bvid', op.bvid);
  }
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
export function retryAfter(value: string | null, now: number, backoffMs: number = L.backoffMs): number {
  if (value && /^\d+(\.\d+)?$/u.test(value.trim())) return Math.ceil(Number(value) * 1000);
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date >= now ? date - now : backoffMs;
}
export interface HttpContext { signal: AbortSignal; deadlineAt: number }
export function createPageHttp(deps: { fetch: typeof fetch; now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }, policy: Readonly<SiteReadPolicy> = readLimits({})) {
  let nextAt = 0;
  return async (op: Operation, ctx: HttpContext): Promise<unknown> => {
    const url = operationUrl(op);
    for (let attempt = 0; attempt < policy.attempts; attempt++) {
      if (ctx.signal.aborted) fail('cancelled');
      const wait = Math.max(0, nextAt - deps.now());
      if (deps.now() + wait >= ctx.deadlineAt) fail('timeout');
      if (wait) await deps.sleep(wait, ctx.signal);
      const remaining = ctx.deadlineAt - deps.now(); if (remaining <= 0) fail('timeout');
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(policy.requestMs, remaining))]);
      let response: Response;
      try { response = await deps.fetch.call(globalThis, url, { method: 'GET', credentials: 'include', redirect: 'error', signal }); }
      catch {
        nextAt = deps.now() + policy.requestSpacingMs;
        if (ctx.signal.aborted) fail('cancelled');
        if (signal.aborted) fail('timeout');
        if (attempt + 1 === policy.attempts) fail('network');
        await retry(policy.backoffMs); continue;
      }
      nextAt = deps.now() + policy.requestSpacingMs;
      const diagnostic = response.status >= 100 && response.status <= 599 ? { httpStatus: response.status } : {};
      if (response.status === 412) { await response.body?.cancel(); fail('challenge', undefined, diagnostic); }
      if (response.status === 429 || response.status >= 500) {
        const waitMs = response.status === 429 ? retryAfter(response.headers.get('Retry-After'), deps.now(), policy.backoffMs) : policy.backoffMs;
        await response.body?.cancel();
        if (attempt + 1 === policy.attempts || waitMs > policy.maxAutomaticWaitMs || deps.now() + waitMs + policy.requestMs > ctx.deadlineAt)
          fail(response.status === 429 ? 'rateLimited' : 'network', waitMs, diagnostic);
        await retry(waitMs); continue;
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('signedOut', undefined, diagnostic); }
      if (!response.ok) { await response.body?.cancel(); fail('invalidData', undefined, diagnostic); }
      let body: Record<string, unknown>;
      try { body = record(await boundedJson(response, policy.responseBytes)); }
      catch (error) { if (error instanceof SiteReadError) throw new SiteReadError({ ...error.failure, ...diagnostic }); throw error; }
      const source = Number.isSafeInteger(body.code) && Math.abs(Number(body.code)) <= 1_000_000_000 ? { sourceCode: Number(body.code) } : {};
      if (body.code === -101) fail('signedOut', undefined, { ...diagnostic, ...source });
      if (body.code === -412) fail('challenge', undefined, { ...diagnostic, ...source });
      if (body.code !== 0) fail('invalidData', undefined, { ...diagnostic, ...source });
      return body.data;
      async function retry(ms: number) {
        if (deps.now() + ms >= ctx.deadlineAt) fail('timeout');
        await deps.sleep(ms, ctx.signal);
      }
    }
    return fail('network');
  };
}
