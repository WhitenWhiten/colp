import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { engineStatusIsStable, engineUnstableFacts, waitForEngineStability } from '../e2e/engine-stability-barrier.js';

const stable = () => ({ ok: true as const, engine: { phase: 'sleeping', recoveryFrozen: false,
  authorityRefreshRequired: false, cooldownPending: false, engineWakeInFlight: false,
  authorityRefreshInFlight: false, credentialReady: true, sessionReady: true, hasPendingWork: false,
  listenerInstalled: true } });

describe('P3-38 engine stability barrier', () => {
  test('does not return before a delayed authority refresh becomes visible and then quiet', async () => {
    let clock = 0; let polls = 0; let authRequests = 2; let sessionRequests = 2;
    const result = await waitForEngineStability({
      readStatus: async () => { polls += 1; return stable(); },
      networkCounts: () => ({ authRequests, sessionRequests }),
      wait: async (milliseconds) => { clock += milliseconds;
        if (clock === 500) { authRequests += 1; sessionRequests += 1; } },
      now: () => clock, timeoutMilliseconds: 5_000, pollIntervalMilliseconds: 250,
      quietWindowMilliseconds: 1_000, requiredStableSamples: 3,
    });
    assert.deepEqual(result, { authRequests: 3, sessionRequests: 3 });
    assert.ok(clock >= 1_500); assert.ok(polls >= 7);
  });

  test('requires consecutive stable samples and auth plus Session network silence', async () => {
    let clock = 0; let sample = 0; const statuses = [stable(),
      { ...stable(), engine: { ...stable().engine, engineWakeInFlight: true } }, stable(), stable(), stable(), stable(), stable()];
    const result = await waitForEngineStability({
      readStatus: async () => statuses[Math.min(sample++, statuses.length - 1)]!,
      networkCounts: () => ({ authRequests: 4, sessionRequests: 4 }),
      wait: async (milliseconds) => { clock += milliseconds; }, now: () => clock,
      timeoutMilliseconds: 5_000, pollIntervalMilliseconds: 250,
      quietWindowMilliseconds: 750, requiredStableSamples: 3,
    });
    assert.deepEqual(result, { authRequests: 4, sessionRequests: 4 });
    assert.ok(sample >= 6);
  });

  test('classifies every stability fact and fails closed for missing or unknown fields', () => {
    for (const phase of ['idle', 'session', 'bootstrap', 'pulling', 'applying', 'acking', 'pushing',
      'offline', 'recovery', 'retired', 'error'] as const) {
      const status = { ...stable(), engine: { ...stable().engine, phase } };
      assert.equal(engineStatusIsStable(status), false, phase);
      assert.ok(engineUnstableFacts(status).includes('phase'), phase);
    }
    const cases = [
      ['status', { ...stable(), ok: false }, 'status'],
      ['phase', { ...stable(), engine: { ...stable().engine, phase: 'offline' } }, 'phase'],
      ['unknown phase', { ...stable(), engine: { ...stable().engine, phase: 'future_phase' } }, 'phase'],
      ['recovery frozen', { ...stable(), engine: { ...stable().engine, recoveryFrozen: true } }, 'recoveryFrozen'],
      ['refresh required', { ...stable(), engine: { ...stable().engine, authorityRefreshRequired: true } }, 'authorityRefreshRequired'],
      ['future cooldown', { ...stable(), engine: { ...stable().engine, cooldownPending: true } }, 'cooldownPending'],
      ['wake in flight', { ...stable(), engine: { ...stable().engine, engineWakeInFlight: true } }, 'engineWakeInFlight'],
      ['authority in flight', { ...stable(), engine: { ...stable().engine, authorityRefreshInFlight: true } }, 'authorityRefreshInFlight'],
      ['credential missing', { ...stable(), engine: { ...stable().engine, credentialReady: false } }, 'credentialReady'],
      ['session missing', { ...stable(), engine: { ...stable().engine, sessionReady: false } }, 'sessionReady'],
      ['recoverable work pending', { ...stable(), engine: { ...stable().engine, hasPendingWork: true } }, 'hasPendingWork'],
      ['bookmark listener missing', { ...stable(), engine: { ...stable().engine, listenerInstalled: false } }, 'listenerInstalled'],
      ['field missing', { ...stable(), engine: { ...stable().engine, hasPendingWork: undefined } }, 'hasPendingWork'],
      ['engine missing', { ok: true }, 'phase'],
    ] as const;
    for (const [label, status, fact] of cases) {
      assert.equal(engineStatusIsStable(status), false, label);
      assert.ok(engineUnstableFacts(status).includes(fact), label);
    }
    assert.equal(engineStatusIsStable(stable()), true);
    assert.deepEqual(engineUnstableFacts(stable()), []);
  });

  test('accepts sleeping idle after expired cooldown facts have been projected as clear', () => {
    assert.equal(engineStatusIsStable(stable()), true);
  });

  test('waits for restart wake and authority work to clear before opening the stable window', async () => {
    let clock = 0; let sample = 0;
    const restarting = [
      { ...stable(), engine: { ...stable().engine, engineWakeInFlight: true } },
      { ...stable(), engine: { ...stable().engine, authorityRefreshInFlight: true } },
      stable(), stable(), stable(), stable(),
    ];
    await waitForEngineStability({
      readStatus: async () => restarting[Math.min(sample++, restarting.length - 1)]!,
      networkCounts: () => ({ authRequests: 4, sessionRequests: 4 }),
      wait: async (milliseconds) => { clock += milliseconds; }, now: () => clock,
      timeoutMilliseconds: 3_000, pollIntervalMilliseconds: 250,
      quietWindowMilliseconds: 500, requiredStableSamples: 3,
    });
    assert.ok(sample >= 5);
  });

  test('fails closed with bounded low-sensitivity diagnostics', async () => {
    let clock = 0;
    await assert.rejects(() => waitForEngineStability({
      readStatus: async () => ({ ...stable(), engine: { ...stable().engine, authorityRefreshInFlight: true } }),
      networkCounts: () => ({ authRequests: 7, sessionRequests: 5 }),
      wait: async (milliseconds) => { clock += milliseconds; }, now: () => clock,
      timeoutMilliseconds: 500, pollIntervalMilliseconds: 250,
      quietWindowMilliseconds: 250, requiredStableSamples: 2,
    }), (error: unknown) => error instanceof Error
      && /engine_stability_timeout/.test(error.message)
      && /"unstableFacts":\["authorityRefreshInFlight"\]/.test(error.message)
      && /"authRequests":7/.test(error.message)
      && /"sessionRequests":5/.test(error.message)
      && !/token|sessionId|cursor|scopeKey|payload/i.test(error.message));
  });
});
