import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  createCreditOverviewClient,
  parseCreditLedgerEntry,
  parseCreditLedgerPage,
  parseCreditOverview,
  resolveCreditBusinessAccountId,
  CreditLedgerError,
} from '../src/credits-ledger.js';

const golden = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/credits-ledger-golden.json'), 'utf8')) as
  Array<{ name: string; value: unknown }>;
const fixture = (name: string): unknown => golden.find((item) => item.name === name)?.value;

describe('credits ledger contract client', () => {
  test('parses the shared golden overview, page, and immutable entry fields', () => {
    const overview = parseCreditOverview(fixture('overview'));
    expect(overview.accountId).toBe('account-example');
    expect(overview.balance.available).toBe(99);
    const page = parseCreditLedgerPage(fixture('ledger'));
    expect(page.snapshot.ledgerSequence).toBe('3');
    expect(page.items[0]).toMatchObject({ kind: 'spend', pointsDelta: -1, chargeId: '20000000-0000-4000-8000-000000000001' });
    const entry = parseCreditLedgerEntry(fixture('entry') && (fixture('entry') as { entry: unknown }).entry);
    expect(entry.sequence).toBe('3');
    expect(entry.task?.kind).toBe('classification_preview');
  });

  test('rejects malformed and unknown ledger facts instead of rendering them as zero', () => {
    expect(() => parseCreditOverview({ accountId: 'a', asOf: 'x', ledgerSequence: '1', balance: { available: 0, reserved: 0, expiringPoints: 0, nextExpiryAt: null }, prices: [] })).toThrow(CreditLedgerError);
    expect(() => parseCreditLedgerEntry({ entryId: 'bad', sequence: '1', kind: 'unknown' })).toThrow(CreditLedgerError);
    expect(() => parseCreditLedgerPage({ accountId: 'a', snapshot: {}, items: [], nextCursor: null })).toThrow(CreditLedgerError);
  });

  test('uses private no-store credentials and preserves credits_* errors', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createCreditOverviewClient({
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-example', businessAccountId: 'account-example', generation: 4 }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(fixture('overview')), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.load();
    expect(calls[0]?.url).toBe('https://known.example/api/v1/me/credits');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.cache).toBe('no-store');

    const failing = createCreditOverviewClient({
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-a', businessAccountId: 'a', generation: 1 }),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'insufficient_credits' } }), { status: 409 }),
    });
    await expect(failing.load()).rejects.toMatchObject({ code: 'insufficient_credits', status: 409 });
  });

  test('rejects a response whose account is not the captured session subject', async () => {
    const client = createCreditOverviewClient({
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-a', businessAccountId: 'account-a', generation: 9 }),
      fetch: async () => new Response(JSON.stringify({ ...(fixture('overview') as object), accountId: 'account-b' }), { status: 200 }),
    });
    await expect(client.load()).rejects.toMatchObject({ code: 'account_mismatch', status: 403 });
  });

  test('returns unsupported when the credits route is 404 or cloud is off', async () => {
    const missing = createCreditOverviewClient({
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-a', businessAccountId: 'account-a', generation: 1 }),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
    });
    await expect(missing.load()).resolves.toBe('unsupported');
    const fetch = vi.fn();
    const off = createCreditOverviewClient({
      cloudEnabled: false,
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-a', businessAccountId: 'account-a', generation: 1 }),
      fetch,
    });
    await expect(off.load()).resolves.toBe('unsupported');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('passes an abort signal to the private overview request', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const client = createCreditOverviewClient({
      getAuthority: async () => ({ status: 'connected' as const, serverOrigin: 'https://known.example', accountKey: 'subject-example', businessAccountId: 'account-example', generation: 1 }),
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Response(JSON.stringify(fixture('overview')), { status: 200 });
      },
    });
    await client.load(controller.signal);
    expect(signal).toBe(controller.signal);
  });

  test('maps the cookie session to the business account before reading credits', async () => {
    const paths: string[] = [];
    const accountId = await resolveCreditBusinessAccountId({
      serverOrigin: 'https://known.example', expectedSubject: 'subject-a',
      fetch: async (url) => {
        paths.push(String(url));
        return String(url).endsWith('/session')
          ? new Response(JSON.stringify({ authenticated: true, csrfToken: 'csrf' }), { status: 200 })
          : String(url).endsWith('/auth/get-session')
          ? new Response(JSON.stringify({ user: { id: 'subject-a' } }), { status: 200 })
          : new Response(JSON.stringify({ account: { id: 'account-a' }, profile: { id: 'account-a' } }), { status: 200 });
      },
    });
    expect(accountId).toBe('account-a');
    expect(paths).toEqual(['https://known.example/api/v1/session', 'https://known.example/api/v1/auth/get-session', 'https://known.example/api/v1/me', 'https://known.example/api/v1/auth/get-session']);
  });
});
