import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import { advanceSyncCircuit } from '../src/sync-circuit-breaker.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';

/**
 * W2B-P2-1: when the person removes the site access of the server (or sets it to "on click"), every credentialed
 * request fails before it leaves with `server_configuration_failed`. That is a wait, not a fault: it is not counted by
 * the circuit breaker, and granting the server's access again wakes Sync at once instead of after its backoff.
 */
const mocks = vi.hoisted(() => ({ wake: vi.fn(), serverOrigin: { current: 'https://known.example' } }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: mocks.wake }));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({ serverOrigin: mocks.serverOrigin.current }) }));

afterEach(() => { vi.clearAllMocks(); mocks.serverOrigin.current = 'https://known.example'; });

describe('the failure table', () => {
  test('missing site access is a transient wait that the circuit breaker does not count', () => {
    assert.deepEqual({ class: classifySyncFailure('server_configuration_failed')?.class,
      exit: classifySyncFailure('server_configuration_failed')?.exit }, { class: 'transient', exit: 'retry' });
    let breaker = undefined as ReturnType<typeof advanceSyncCircuit>;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      breaker = advanceSyncCircuit(breaker, 'server_configuration_failed', 'progress', 1_000_000 + attempt * 1_000);
    }
    assert.equal(breaker, undefined, 'eight refusals later nothing is counted and no cooldown starts');
  });
});

describe('a permission change', () => {
  test('a grant of the configured server wakes Sync', async () => {
    const { wakeSyncForServerPermission } = await import('../src/sw/server-permission.js');
    await wakeSyncForServerPermission({ origins: ['https://known.example/*'] });
    assert.deepEqual(mocks.wake.mock.calls, [['manual']]);
  });

  test('another site, a bookmarks-only change and an empty change do not', async () => {
    const { wakeSyncForServerPermission } = await import('../src/sw/server-permission.js');
    await wakeSyncForServerPermission({ origins: ['https://elsewhere.example/*'] });
    await wakeSyncForServerPermission({ origins: [] });
    await wakeSyncForServerPermission({});
    assert.equal(mocks.wake.mock.calls.length, 0);
  });

  test('it follows the server the extension is configured for', async () => {
    mocks.serverOrigin.current = 'https://self-hosted.example:8443';
    const { wakeSyncForServerPermission } = await import('../src/sw/server-permission.js');
    await wakeSyncForServerPermission({ origins: ['https://known.example/*'] });
    assert.equal(mocks.wake.mock.calls.length, 0);
    await wakeSyncForServerPermission({ origins: ['https://self-hosted.example:8443/*'] });
    assert.equal(mocks.wake.mock.calls.length, 1);
  });
});
