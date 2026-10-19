import { RULESET_MAX_BYTES } from './ruleset-format.js';
import type { FailureCode, RefreshOutcome } from './subscription-store.js';

/**
 * Fetching a subscribed rule set (doc 17 §8 Fetch, R14): a plain GET of the subscribed address and
 * nothing else — no cookies, no body, nothing about the Owner's bookmarks (RS-15.5). The address is
 * `https`, or `http` on this machine for development; the browser must have granted its origin, and a
 * redirect may not leave it. The body is read through a 2 MB cap, the whole fetch within 30 seconds, and
 * an unchanged file comes back as 304 against the ETag kept from the last one.
 */
export const SUBSCRIPTION_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export type SubscriptionAddress = { readonly ok: true; readonly url: string; readonly origin: string } | { readonly ok: false };
/** An address this build subscribes to, without its fragment; never one with a user name or password in it. */
export function subscriptionAddress(input: string): SubscriptionAddress {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return { ok: false }; }
  if (url.username || url.password) return { ok: false };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return { ok: false };
  url.hash = '';
  return { ok: true, url: url.href, origin: url.origin };
}
/** The optional host permission one subscription needs, requested in the Subscribe gesture. */
export const subscriptionOriginPattern = (origin: string) => `${origin}/*`;

export interface FetchPorts {
  readonly fetch: typeof fetch;
  /** Whether the browser has granted this origin. */
  readonly granted: (origin: string) => Promise<boolean>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const failed = (code: FailureCode, status?: number): RefreshOutcome => ({ kind: 'failed', code, ...(status !== undefined ? { status } : {}) });

/** The body, or null past `limit` bytes; reading stops there. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > limit ? null : whole;
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
  return body;
}

export async function fetchSubscription(target: { readonly url: string; readonly origin: string; readonly etag: string | null },
  ports: FetchPorts): Promise<RefreshOutcome> {
  const address = subscriptionAddress(target.url);
  if (!address.ok || address.origin !== target.origin) return failed('unsupported');
  if (!await ports.granted(target.origin).catch(() => false)) return failed('permission');
  const limit = ports.maxBytes ?? RULESET_MAX_BYTES, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ports.timeoutMs ?? SUBSCRIPTION_TIMEOUT_MS);
  try {
    const response = await ports.fetch(address.url, { method: 'GET', headers: target.etag ? { 'If-None-Match': target.etag } : {}, credentials: 'omit',
      redirect: 'follow', cache: 'no-store', signal: controller.signal });
    if (response.url && new URL(response.url).origin !== target.origin) { await response.body?.cancel().catch(() => undefined); return failed('unsupported'); }
    if (response.status === 304) return target.etag ? { kind: 'notModified' } : failed('http', 304);
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return failed('http', response.status); }
    const declared = response.headers.get('Content-Length');
    if (declared !== null && Number(declared) > limit) { await response.body?.cancel().catch(() => undefined); return failed('tooLarge'); }
    const body = await readCapped(response, limit);
    if (!body) return failed('tooLarge');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return failed('invalid'); }
    return { kind: 'fetched', text, etag: response.headers.get('ETag') };
  } catch {
    return failed('network');
  } finally {
    clearTimeout(timer);
  }
}
