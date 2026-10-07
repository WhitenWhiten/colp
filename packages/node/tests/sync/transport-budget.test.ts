import { describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES,
  defaultServerTransportBudget,
  encodeSyncTransportBudgetHeader,
  jsonFitsTransportBudget,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  negotiateSyncTransportBudget,
  parseSyncTransportBudget,
  parseSyncTransportBudgetHeader,
  readDeclaredTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  SYNC_TRANSPORT_BUDGET_MAX_BYTES,
  SYNC_TRANSPORT_BUDGET_MIN_BYTES,
  utf8JsonByteLength,
} from '../../src/sync/index.js';
import expectedBoundaries from '../fixtures/sync-transport-budget-boundaries.json' with { type: 'json' };

const valid = Object.freeze({
  pullResponseBytes: 512 * 1024,
  snapshotPageBytes: 1024 * 1024,
  effectPageBytes: 64 * 1024,
  effectAggregateBytes: 256 * 1024,
});

describe('SYNC-Q-003 SyncTransportBudget', () => {
  it('treats a missing client declaration as the legacy 2 MiB receive cap', () => {
    expect(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES).toBe(2 * 1024 * 1024);
    expect(legacySyncTransportBudget()).toEqual({
      pullResponseBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
      snapshotPageBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
      effectPageBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
      effectAggregateBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    });
    expect(readDeclaredTransportBudget(undefined)).toBeUndefined();
    expect(readDeclaredTransportBudget(null)).toBeUndefined();
    expect(readDeclaredTransportBudget({})).toBeUndefined();
    expect(negotiateSyncTransportBudget(undefined, defaultServerTransportBudget()).pullResponseBytes)
      .toBe(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
  });

  it('negotiates each field as min(client, server) and never exceeds the client', () => {
    const client = parseSyncTransportBudget({
      pullResponseBytes: 2 * 1024 * 1024,
      snapshotPageBytes: 2 * 1024 * 1024,
      effectPageBytes: 2 * 1024 * 1024,
      effectAggregateBytes: 2 * 1024 * 1024,
    });
    const server = defaultServerTransportBudget(AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES);
    const negotiated = negotiateSyncTransportBudget(client, server);
    expect(negotiated.pullResponseBytes).toBe(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    expect(negotiated.snapshotPageBytes).toBe(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    expect(negotiated.effectPageBytes).toBe(AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES);
    expect(negotiated.effectAggregateBytes).toBe(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    const tighter = negotiateSyncTransportBudget(valid, {
      ...server, pullResponseBytes: 8 * 1024 * 1024, snapshotPageBytes: 8 * 1024 * 1024,
    });
    expect(tighter.pullResponseBytes).toBe(valid.pullResponseBytes);
    expect(tighter.snapshotPageBytes).toBe(valid.snapshotPageBytes);
  });

  it('fails closed on tampered or out-of-range declarations', () => {
    expect(() => parseSyncTransportBudget({ ...valid, extra: 1 })).toThrow(/invalid/i);
    expect(() => parseSyncTransportBudget({ ...valid, pullResponseBytes: SYNC_TRANSPORT_BUDGET_MIN_BYTES - 1 }))
      .toThrow(/range/i);
    expect(() => parseSyncTransportBudget({ ...valid, pullResponseBytes: SYNC_TRANSPORT_BUDGET_MAX_BYTES + 1 }))
      .toThrow(/range/i);
    expect(() => parseSyncTransportBudget({ ...valid, pullResponseBytes: 32_768.5 })).toThrow(/range/i);
    expect(() => parseSyncTransportBudget({
      ...valid, effectPageBytes: 256 * 1024, effectAggregateBytes: 64 * 1024,
    })).toThrow(/effectPageBytes/i);
    expect(() => readDeclaredTransportBudget([])).toThrow(/plain object/i);
    expect(() => readDeclaredTransportBudget({
      [SYNC_TRANSPORT_BUDGET_EXTENSION]: { ...valid, pullResponseBytes: '2MiB' },
    })).toThrow(/range|invalid/i);
    expect(() => parseSyncTransportBudgetHeader('{')).toThrow(/invalid/i);
  });

  it('round-trips the Session header and defaults a missing header to legacy 2 MiB', () => {
    expect(SYNC_TRANSPORT_BUDGET_HEADER).toBe('Known-Sync-Transport-Budget');
    const header = encodeSyncTransportBudgetHeader(valid);
    expect(parseSyncTransportBudgetHeader(header)).toEqual(valid);
    expect(parseSyncTransportBudgetHeader(null)).toEqual(legacySyncTransportBudget());
    expect(parseSyncTransportBudgetHeader('')).toEqual(legacySyncTransportBudget());
  });

  it('rejects an overlong header before JSON parsing', () => {
    expect(() => parseSyncTransportBudgetHeader('{"effectPageBytes":' + '9'.repeat(2000)))
      .toThrow(/byte budget/i);
    expect(() => parseSyncTransportBudgetHeader(42 as never)).toThrow(/invalid/i);
  });

  it('locks the shared 2/5/8 MiB boundary fixture including UTF-8 envelope overhead', () => {
    expect(expectedBoundaries.boundaries.map((row) => row.id)).toEqual([
      'legacy-2mib', 'mid-5mib', 'high-8mib',
    ]);
    expect(expectedBoundaries.boundaries[0]?.pullResponseBytes).toBe(LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    for (const row of expectedBoundaries.boundaries) {
      const budget = parseSyncTransportBudget({
        pullResponseBytes: row.pullResponseBytes,
        snapshotPageBytes: row.snapshotPageBytes,
        effectPageBytes: row.effectPageBytes,
        effectAggregateBytes: row.effectAggregateBytes,
      });
      expect(budget.pullResponseBytes).toBe(row.pullResponseBytes);
      const limit = row.pullResponseBytes;
      const under = { t: 'x'.repeat(16) };
      expect(utf8JsonByteLength(under)).toBeLessThan(limit);
      expect(jsonFitsTransportBudget(under, limit)).toBe(true);
      const over = { t: 'x'.repeat(limit) };
      expect(utf8JsonByteLength(over)).toBeGreaterThan(limit);
      expect(jsonFitsTransportBudget(over, limit)).toBe(false);
    }
  });

  it('measures UTF-8 JSON envelope bytes at limit-1, limit, and limit+1 including multi-byte text', () => {
    const limit = 64;
    const ascii = { t: 'a'.repeat(limit) };
    const under = { t: 'é' };
    expect(utf8JsonByteLength(under)).toBeLessThan(limit);
    expect(jsonFitsTransportBudget(under, limit)).toBe(true);
    const exact = findExactUtf8Json(limit);
    expect(utf8JsonByteLength(exact)).toBe(limit);
    expect(jsonFitsTransportBudget(exact, limit)).toBe(true);
    expect(jsonFitsTransportBudget(ascii, limit)).toBe(false);
    expect(utf8JsonByteLength(ascii)).toBeGreaterThan(limit);
    const over = { t: `${exact.t}é` };
    expect(utf8JsonByteLength(over)).toBeGreaterThan(limit);
    expect(jsonFitsTransportBudget(over, limit)).toBe(false);
    expect(jsonFitsTransportBudget(exact, limit - 1)).toBe(false);
  });
});

function findExactUtf8Json(limit: number): { readonly t: string } {
  let text = '';
  while (utf8JsonByteLength({ t: `${text}é` }) <= limit) text += 'é';
  while (utf8JsonByteLength({ t: text }) < limit) text += 'x';
  if (utf8JsonByteLength({ t: text }) !== limit) throw new Error('unable to pin exact UTF-8 JSON length');
  return { t: text };
}
