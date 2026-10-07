import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  AUTH_DCR_METRIC_NAME_ALLOWLIST,
  createDcrRegistrationCapacityGuard,
  incrementAuthDcrMetric,
  type DcrRegistrationReservationStore,
  type DcrReserveResult,
} from '../../../src/infrastructure/auth/dcr-registration-capacity.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

function reserved(
  reservationId = 'reservation-1',
  reclaimed: { readonly anonymous?: number; readonly owned?: number } = {},
): DcrReserveResult {
  return {
    ok: true,
    reservationId,
    reclaimedAnonymous: reclaimed.anonymous ?? 0,
    reclaimedOwned: reclaimed.owned ?? 0,
  };
}

function denied(
  reason: Extract<DcrReserveResult, { ok: false }>['reason'],
  reclaimed: { readonly anonymous?: number; readonly owned?: number } = {},
): DcrReserveResult {
  return {
    ok: false,
    reason,
    reclaimedAnonymous: reclaimed.anonymous ?? 0,
    reclaimedOwned: reclaimed.owned ?? 0,
  };
}

function store(overrides: Partial<DcrRegistrationReservationStore> = {}): DcrRegistrationReservationStore {
  return {
    reserveAnonymous: async () => reserved(),
    reserveOwned: async () => reserved('owned-1'),
    finalize: async () => undefined,
    completeOwned: async () => undefined,
    cancel: async () => undefined,
    ...overrides,
  };
}

async function assertUnavailable(response: Response): Promise<void> {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), {
    error: 'temporarily_unavailable',
    error_description: 'Dynamic client registration capacity is temporarily unavailable.',
  });
}

describe('anonymous DCR capacity guard', () => {
  test('capacity exhaustion and reservation-store failure fail closed before Better Auth', async () => {
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return Response.json({ client_id: 'must-not-run' }, { status: 201 });
    };

    await assertUnavailable(await createDcrRegistrationCapacityGuard(store({
      reserveAnonymous: async () => denied('anonymous'),
    })).dispatch(operation));
    await assertUnavailable(await createDcrRegistrationCapacityGuard(store({
      reserveAnonymous: async () => { throw new Error('database unavailable'); },
    })).dispatch(operation));
    assert.equal(calls, 0);
  });

  test('a 201 is returned only after client_id finalizes the reserved slot', async () => {
    const finalized: Array<readonly [string, string]> = [];
    const guard = createDcrRegistrationCapacityGuard(store({
      finalize: async (reservationId, clientId) => { finalized.push([reservationId, clientId]); },
    }));
    const response = await guard.dispatch(async () => Response.json({
      client_id: 'dcr-client-1',
      token_endpoint_auth_method: 'none',
    }, { status: 201 }));

    assert.equal(response.status, 201);
    assert.deepEqual(finalized, [['reservation-1', 'dcr-client-1']]);
    assert.equal((await response.json() as { client_id?: string }).client_id, 'dcr-client-1');
  });

  test('failed/malformed handler outcomes cannot leak a free capacity slot', async () => {
    const cancelled: string[] = [];
    const metrics = new InMemoryMetrics();
    const guard = createDcrRegistrationCapacityGuard(store({
      cancel: async (id) => { cancelled.push(id); },
    }), { metrics });

    const rejected = await guard.dispatch(async () => Response.json({ error: 'invalid_client_metadata' }, { status: 400 }));
    assert.equal(rejected.status, 400);
    assert.deepEqual(cancelled, ['reservation-1'], 'a response that created no client releases its slot');

    const malformed = await guard.dispatch(async () => Response.json({ unexpected: true }, { status: 201 }));
    await assertUnavailable(malformed);
    assert.deepEqual(
      cancelled,
      ['reservation-1'],
      'a malformed 201 keeps its bounded reservation for database reconciliation',
    );
    assert.equal(metrics.get('auth.dcr.admission.malformed_201'), 1);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.accepted'), 0);
  });

  test('handler exceptions release reservations; finalization failures hide the untracked client', async () => {
    const cancelled: string[] = [];
    const throwing = createDcrRegistrationCapacityGuard(store({
      cancel: async (id) => { cancelled.push(id); },
    }));
    await assert.rejects(
      throwing.dispatch(async () => { throw new Error('handler failed'); }),
      /handler failed/u,
    );
    assert.deepEqual(cancelled, ['reservation-1']);

    const metrics = new InMemoryMetrics();
    const failing = createDcrRegistrationCapacityGuard(store({
      finalize: async () => { throw new Error('lost database'); },
    }), { metrics });
    await assertUnavailable(await failing.dispatch(async () =>
      Response.json({ client_id: 'committed-but-untracked' }, { status: 201 })));
    assert.equal(metrics.get('auth.dcr.admission.store_error'), 1);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.accepted'), 0);
  });

  test('handler and cancellation failures are both preserved and reported', async () => {
    const handlerFailure = new Error('handler failed');
    const cancellationFailure = new Error('cancel failed');
    const metrics = new InMemoryMetrics();
    const guard = createDcrRegistrationCapacityGuard(store({
      cancel: async () => { throw cancellationFailure; },
    }), { metrics });

    await assert.rejects(guard.dispatch(async () => { throw handlerFailure; }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [handlerFailure, cancellationFailure]);
      return true;
    });
    assert.equal(metrics.get('auth.dcr.admission.store_error'), 1);
  });

  test('rejected responses remain authoritative when cancellation is temporarily unavailable', async () => {
    const metrics = new InMemoryMetrics();
    const response = await createDcrRegistrationCapacityGuard(store({
      cancel: async () => { throw new Error('cancel failed'); },
    }), { metrics }).dispatch(async () =>
      Response.json({ error: 'invalid_client_metadata' }, { status: 400 }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_client_metadata' });
    assert.equal(metrics.get('auth.dcr.admission.store_error'), 1);
  });

  test('session-owned exhaustion and store failure fail closed before Better Auth', async () => {
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return Response.json({ client_id: 'must-not-run' }, { status: 201 });
    };
    await assertUnavailable(await createDcrRegistrationCapacityGuard(store({
      reserveOwned: async () => denied('owned_user'),
    })).dispatchOwned(operation, 'user-1'));
    await assertUnavailable(await createDcrRegistrationCapacityGuard(store({
      reserveOwned: async () => denied('owned_global'),
    })).dispatchOwned(operation, 'user-1'));
    await assertUnavailable(await createDcrRegistrationCapacityGuard(store({
      reserveOwned: async () => { throw new Error('database unavailable'); },
    })).dispatchOwned(operation, 'user-1'));
    await assertUnavailable(await createDcrRegistrationCapacityGuard(store()).dispatchOwned(operation, ''));
    assert.equal(calls, 0);
  });

  test('owned dispatch cancels the reservation on throw and 400; 201 completes without finalize', async () => {
    const cancelled: string[] = [];
    const finalized: Array<readonly [string, string]> = [];
    const completed: Array<readonly [string, string]> = [];
    const guard = createDcrRegistrationCapacityGuard(store({
      cancel: async (id) => { cancelled.push(id); },
      finalize: async (reservationId, clientId) => { finalized.push([reservationId, clientId]); },
      completeOwned: async (reservationId, clientId) => { completed.push([reservationId, clientId]); },
    }));

    await assert.rejects(
      guard.dispatchOwned(async () => { throw new Error('handler failed'); }, 'user-1'),
      /handler failed/u,
    );
    assert.deepEqual(cancelled, ['owned-1']);

    const rejected = await guard.dispatchOwned(
      async () => Response.json({ error: 'invalid_client_metadata' }, { status: 400 }),
      'user-1',
    );
    assert.equal(rejected.status, 400);
    assert.deepEqual(cancelled, ['owned-1', 'owned-1']);

    const accepted = await guard.dispatchOwned(
      async () => Response.json({ client_id: 'owned-client' }, { status: 201 }),
      'user-1',
    );
    assert.equal(accepted.status, 201);
    assert.deepEqual(finalized, []);
    assert.deepEqual(completed, [['owned-1', 'owned-client']]);
    assert.deepEqual(cancelled, ['owned-1', 'owned-1']);
  });

  test('owned 201 that cannot complete occupancy fails closed as malformed_201', async () => {
    const metrics = new InMemoryMetrics();
    const cancelled: string[] = [];
    const response = await createDcrRegistrationCapacityGuard(store({
      completeOwned: async () => { throw new Error('unowned client'); },
      cancel: async (id) => { cancelled.push(id); },
    }), { metrics }).dispatchOwned(
      async () => Response.json({ client_id: 'anon-looking' }, { status: 201 }),
      'user-1',
    );
    await assertUnavailable(response);
    assert.equal(metrics.get('auth.dcr.admission.malformed_201'), 1);
    assert.equal(metrics.get('auth.dcr.admission.owned.accepted'), 0);
    assert.deepEqual(cancelled, [], 'unowned 201 keeps the owned pending occupancy');
  });
});

describe('sealed DCR admission metrics', () => {
  test('denied anonymous capacity increments denied_capacity and not accepted', async () => {
    const metrics = new InMemoryMetrics();
    const response = await createDcrRegistrationCapacityGuard(store({
      reserveAnonymous: async () => denied('anonymous'),
    }), { metrics }).dispatch(async () => Response.json({ client_id: 'must-not-run' }, { status: 201 }));
    await assertUnavailable(response);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.denied_capacity'), 1);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.accepted'), 0);
    assert.equal(metrics.get('auth.dcr.admission.owned.accepted'), 0);
  });

  test('accepted anonymous 201 increments accepted; missing metrics is a no-op', async () => {
    const metrics = new InMemoryMetrics();
    const withMetrics = await createDcrRegistrationCapacityGuard(store(), { metrics }).dispatch(async () =>
      Response.json({ client_id: 'dcr-client-1' }, { status: 201 }));
    assert.equal(withMetrics.status, 201);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.accepted'), 1);
    assert.equal(metrics.get('auth.dcr.admission.anonymous.denied_capacity'), 0);

    const withoutMetrics = await createDcrRegistrationCapacityGuard(store()).dispatch(async () =>
      Response.json({ client_id: 'dcr-client-2' }, { status: 201 }));
    assert.equal(withoutMetrics.status, 201);
  });

  test('owned deny/accept and reclaim counts increment the frozen names', async () => {
    const metrics = new InMemoryMetrics();
    const guard = createDcrRegistrationCapacityGuard(store({
      reserveOwned: async () => denied('owned_user', { owned: 2 }),
    }), { metrics });
    await assertUnavailable(await guard.dispatchOwned(async () =>
      Response.json({ client_id: 'must-not-run' }, { status: 201 }), 'user-1'));
    assert.equal(metrics.get('auth.dcr.admission.owned.denied_user'), 1);
    assert.equal(metrics.get('auth.dcr.admission.owned.denied_global'), 0);
    assert.equal(metrics.get('auth.dcr.admission.owned.accepted'), 0);
    assert.equal(metrics.get('auth.dcr.reclaim.owned'), 2);

    const accepted = await createDcrRegistrationCapacityGuard(store({
      reserveOwned: async () => reserved('owned-1'),
    }), { metrics }).dispatchOwned(async () =>
      Response.json({ client_id: 'owned-client' }, { status: 201 }), 'user-1');
    assert.equal(accepted.status, 201);
    assert.equal(metrics.get('auth.dcr.admission.owned.accepted'), 1);

    const zeroReclaim = new InMemoryMetrics();
    await createDcrRegistrationCapacityGuard(store({
      reserveAnonymous: async () => denied('anonymous', { anonymous: 0 }),
    }), { metrics: zeroReclaim }).dispatch(async () => Response.json({ client_id: 'x' }, { status: 201 }));
    assert.equal(zeroReclaim.get('auth.dcr.reclaim.anonymous'), 0);
  });

  test('unknown metric names throw; the allowlist is frozen and prefixed', () => {
    const metrics = new InMemoryMetrics();
    assert.equal(Object.isFrozen(AUTH_DCR_METRIC_NAME_ALLOWLIST), true);
    assert.throws(
      () => incrementAuthDcrMetric(metrics, 'auth.dcr.admission.not_a_metric'),
      /Unknown DCR admission metric/u,
    );
    assert.equal(metrics.get('auth.dcr.admission.not_a_metric'), 0);
    for (const name of AUTH_DCR_METRIC_NAME_ALLOWLIST) {
      assert.equal(name.startsWith('auth.dcr.'), true, name);
      assert.doesNotMatch(name, /@|https?:|mailto:/iu, name);
    }
  });
});
