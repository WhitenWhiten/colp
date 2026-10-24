import { SyncFailureError } from './sync-failure-class.js';
import { canonicalAuthoritativeEffectPageDigest, expandAuthoritativeEffectPageUrl } from '@know-n/colp/sync/canonical';
import { readBoundedJson } from './json-response.js';
import { statusFailure } from './sync-transport-failure.js';
import { schemaRejection } from './durable-sync-engine-errors.js';
import { authoritativeEffectPage } from './generated/pull-effect-validators.js';
import type { EffectPageDownloadRecord, JsonValue, SyncScope, createSyncStateStore } from './sync-state-store.js';

const MAX_BACKOFF_MS = 5 * 60_000;

export class EffectPageRateLimitedError extends Error {
  readonly code = 'rate_limited';
  constructor(readonly retryAfterMilliseconds: number) {
    super('rate_limited');
    this.name = 'EffectPageRateLimitedError';
  }
}

export interface EffectPageDownloadRef {
  readonly effectId: string;
  readonly pageCount: number;
  readonly memberCount: number;
}

export async function downloadAuthoritativeEffectPages(input: {
  readonly scope: SyncScope;
  readonly store: Pick<ReturnType<typeof createSyncStateStore>,
    'getEffectDownload' | 'putEffectDownload' | 'clearEffectDownload'>;
  readonly refs: readonly EffectPageDownloadRef[];
  readonly template: string;
  readonly authority: string;
  readonly headers: HeadersInit;
  readonly remainingBytes: number;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly requestTimeoutMilliseconds?: number;
}): Promise<unknown[]> {
  const pages: unknown[] = [];
  let remainingBytes = input.remainingBytes;
  for (const ref of input.refs) {
    const batch = await downloadOne(input, ref, remainingBytes);
    pages.push(...batch);
    remainingBytes -= byteLength(batch);
  }
  return pages;
}

async function downloadOne(
  input: Parameters<typeof downloadAuthoritativeEffectPages>[0],
  ref: EffectPageDownloadRef,
  remainingBytes: number,
): Promise<unknown[]> {
  const existing = await input.store.getEffectDownload(input.scope, ref.effectId);
  if (existing && existing.retryNotBefore > input.now()) {
    throw new EffectPageRateLimitedError(existing.retryNotBefore - input.now());
  }
  let record: EffectPageDownloadRecord = existing ?? {
    effectId: ref.effectId, pageCount: ref.pageCount, nextPageNumber: 1, lastDigest: null,
    remainingBytes, remainingMembers: ref.memberCount, retryNotBefore: 0, pages: [],
  };
  if (record.pageCount !== ref.pageCount) throw new SyncFailureError('effect_page_invalid');
  while (record.nextPageNumber <= ref.pageCount) {
    if (record.remainingBytes <= 0) throw new SyncFailureError('pull_page_invalid');
    const raw = expandAuthoritativeEffectPageUrl(input.template, ref.effectId, record.nextPageNumber);
    if (new URL(raw).origin !== input.authority) throw new SyncFailureError('effect_endpoint_binding_invalid');
    // Browser `fetch` is a branded global function. Calling it as
    // `input.fetch(...)` supplies the options object as `this`, which Chromium
    // rejects with "Illegal invocation". Detach the implementation first so
    // both the native global and injected test fetchers receive no receiver.
    const fetcher = input.fetch;
    const controller = new AbortController();
    const timeoutMilliseconds = input.requestTimeoutMilliseconds ?? 15_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    let rawPage: unknown;
    try {
      const response = await fetcher(raw, {
        redirect: 'error', cache: 'no-store', credentials: 'omit', headers: input.headers, signal: controller.signal,
      });
      if (response.status === 429) {
        const retryAfterMilliseconds = retryAfterFrom(response, input.now());
        await input.store.putEffectDownload(input.scope, { ...record, retryNotBefore: input.now() + retryAfterMilliseconds });
        throw new EffectPageRateLimitedError(retryAfterMilliseconds);
      }
      // Rule A: only a complete, parseable page that fails its checks is an integrity verdict. A 5xx or 408 is
      // transient; the server hides every authority failure as 404 (and 401/403/410 mean the same), so those renew
      // the Session through the authority freeze instead of freezing the replica on an integrity code.
      if (!response.ok) throw statusFailure(response, { authority: 'effect_page_transport_unavailable',
        other: 'effect_page_failed' }, input.now());
      rawPage = await readBoundedJson(response, record.remainingBytes, 'effect_page_invalid',
        { signal: controller.signal, timeoutMilliseconds });
    } finally { clearTimeout(timeout); }
    if (!authoritativeEffectPage(rawPage)) throw schemaRejection(authoritativeEffectPage, 'effect_page_invalid');
    const page = rawPage as {
      readonly effectId: string; readonly pageNumber: number; readonly pageCount: number;
      readonly previousPageDigest: string | null; readonly pageDigest: string;
      readonly members: readonly string[];
    };
    if (page.effectId !== ref.effectId || page.pageNumber !== record.nextPageNumber
        || page.pageCount !== ref.pageCount || page.previousPageDigest !== record.lastDigest
        || page.pageDigest !== canonicalAuthoritativeEffectPageDigest(page as unknown as Record<string, unknown>)) {
      throw new SyncFailureError('effect_page_invalid');
    }
    record = {
      ...record,
      nextPageNumber: record.nextPageNumber + 1,
      lastDigest: page.pageDigest,
      remainingBytes: record.remainingBytes - byteLength(page),
      remainingMembers: record.remainingMembers - page.members.length,
      retryNotBefore: 0,
      pages: [...record.pages, page as unknown as JsonValue],
    };
    await input.store.putEffectDownload(input.scope, record);
  }
  await input.store.clearEffectDownload(input.scope, ref.effectId);
  return [...record.pages];
}

function retryAfterFrom(response: Response, now: number): number {
  const value = response.headers.get('Retry-After');
  let delay = 0;
  if (value && /^\d+$/u.test(value)) delay = Number(value) * 1_000;
  else if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  return Math.min(MAX_BACKOFF_MS, Math.max(1_000, delay));
}

function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
