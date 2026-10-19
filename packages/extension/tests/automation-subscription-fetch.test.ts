import { describe, expect, it, vi } from 'vitest';
import { RULESET_MAX_BYTES } from '../src/automation/ruleset-format.js';
import { fetchSubscription, subscriptionAddress, type FetchPorts } from '../src/automation/subscription-fetch.js';

/** Doc 17 §8 Fetch, R14, RS-15.5: the address rule, the origin grant, the 2 MB cap, the redirect check, the timeout and the ETag. */
const URL_A = 'https://rules.example.org/community.json', ORIGIN_A = 'https://rules.example.org';
const target = (over: Partial<{ url: string; origin: string; etag: string | null }> = {}) => ({ url: URL_A, origin: ORIGIN_A, etag: null, ...over });

function answer(body: BodyInit | null, init: ResponseInit & { url?: string } = {}): Response {
  const response = new Response(body, init);
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}
function ports(reply: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, over: Partial<FetchPorts> = {}) {
  const fetch = vi.fn(reply);
  return { fetch, ports: { fetch: fetch as unknown as typeof globalThis.fetch, granted: async () => true, ...over } satisfies FetchPorts };
}
/** A body sent in pieces, with no Content-Length to go by. */
function streamed(size: number, piece = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({ pull(controller) {
    if (sent >= size) { controller.close(); return; }
    const next = Math.min(piece, size - sent); sent += next;
    controller.enqueue(new Uint8Array(next).fill(0x20));
  } });
}

describe('which addresses can be subscribed to (R14)', () => {
  it('takes https anywhere and http on this machine only, without a user name, password or fragment', () => {
    expect(subscriptionAddress(' https://rules.example.org/a.json#top ')).toEqual({ ok: true, url: 'https://rules.example.org/a.json', origin: ORIGIN_A });
    expect(subscriptionAddress('http://localhost:8080/a.json')).toMatchObject({ ok: true, origin: 'http://localhost:8080' });
    expect(subscriptionAddress('http://127.0.0.1:9/a.json')).toMatchObject({ ok: true, origin: 'http://127.0.0.1:9' });
    for (const refused of ['http://rules.example.org/a.json', 'http://10.0.0.2/a.json', 'ftp://rules.example.org/a.json', 'https://me:secret@rules.example.org/a.json',
      'file:///tmp/a.json', 'not a url']) expect(subscriptionAddress(refused)).toEqual({ ok: false });
  });

  it('refuses an http address off this machine before anything is fetched', async () => {
    const { fetch, ports: given } = ports(async () => answer('{}'));
    expect(await fetchSubscription(target({ url: 'http://rules.example.org/a.json', origin: 'http://rules.example.org' }), given))
      .toEqual({ kind: 'failed', code: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('one fetch', () => {
  it('needs the origin granted, and fetches nothing without it', async () => {
    const { fetch, ports: given } = ports(async () => answer('{}'), { granted: async () => false });
    expect(await fetchSubscription(target(), given)).toEqual({ kind: 'failed', code: 'permission' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is a bare GET with no cookies and no body, and an unchanged file is a 304 against the ETag', async () => {
    const { fetch, ports: given } = ports(async () => answer(null, { status: 304 }));
    expect(await fetchSubscription(target({ etag: '"v7"' }), given)).toEqual({ kind: 'notModified' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL_A);
    expect(init).toMatchObject({ method: 'GET', headers: { 'If-None-Match': '"v7"' }, credentials: 'omit', redirect: 'follow', cache: 'no-store' });
    expect(init).not.toHaveProperty('body');
  });

  it('returns the text and its ETag', async () => {
    const { ports: given } = ports(async () => answer('{"format":"colp.ruleset/v1"}', { headers: { ETag: '"v8"' } }));
    expect(await fetchSubscription(target(), given)).toEqual({ kind: 'fetched', text: '{"format":"colp.ruleset/v1"}', etag: '"v8"' });
  });

  it('takes 2 MB and refuses 2 MB and one byte as tooLarge, by its length or while reading', async () => {
    const exact = ports(async () => answer(streamed(RULESET_MAX_BYTES)));
    expect(await fetchSubscription(target(), exact.ports)).toMatchObject({ kind: 'fetched' });
    const over = ports(async () => answer(streamed(RULESET_MAX_BYTES + 1)));
    expect(await fetchSubscription(target(), over.ports)).toEqual({ kind: 'failed', code: 'tooLarge' });
    const declared = ports(async () => answer('{}', { headers: { 'Content-Length': String(RULESET_MAX_BYTES + 1) } }));
    expect(await fetchSubscription(target(), declared.ports)).toEqual({ kind: 'failed', code: 'tooLarge' });
  });

  it('refuses a redirect that leaves the granted origin', async () => {
    const { ports: given } = ports(async () => answer('{}', { url: 'https://elsewhere.example.net/community.json' }));
    expect(await fetchSubscription(target(), given)).toEqual({ kind: 'failed', code: 'unsupported' });
    const same = ports(async () => answer('{}', { url: 'https://rules.example.org/v2/community.json' }));
    expect(await fetchSubscription(target(), same.ports)).toMatchObject({ kind: 'fetched' });
  });

  it('names an HTTP failure by its status, an unreachable address or a stalled one as network, and a body that is not UTF-8 as invalid', async () => {
    expect(await fetchSubscription(target(), ports(async () => answer('down', { status: 503 })).ports)).toEqual({ kind: 'failed', code: 'http', status: 503 });
    expect(await fetchSubscription(target(), ports(async () => { throw new TypeError('Failed to fetch'); }).ports)).toEqual({ kind: 'failed', code: 'network' });
    const stalled = ports((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      { timeoutMs: 5 });
    expect(await fetchSubscription(target(), stalled.ports)).toEqual({ kind: 'failed', code: 'network' });
    expect(await fetchSubscription(target(), ports(async () => answer(new Uint8Array([0xff, 0xfe, 0x00]))).ports)).toEqual({ kind: 'failed', code: 'invalid' });
  });
});
