import { Kysely, PostgresDialect } from 'kysely';
import { expect, test, vi } from 'vitest';
import type { ConnectionProfileInput, TargetInput } from '@know-n/colp/automation';
import { createTargetStore } from '../../../src/infrastructure/automation/target-store.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';

const ownerId = 'owner';
const profileConfiguration = (id: string) => ({
  name: id, authorizedClientId: `client-${id}`, credentialBindingId: `binding-${id}`,
  automationEnabled: true, catalogs: ['automationWorker'],
}) as ConnectionProfileInput;
const targetConfiguration = (profileId: string) => ({
  name: 'worker', providerLabel: '', broadcastOptIn: false, privacy: 'standard',
  connectionProfileId: profileId, wakeMode: 'events',
}) as TargetInput;
const profileRow = (id: string) => ({
  id, owner_id: ownerId, revision: '7', configuration_json: profileConfiguration(id),
  observation_json: { accountId: ownerId } as Record<string, unknown>, created_at: '2026-11-17T00:00:00Z',
});
const targetRow = (id: string, profileId: string) => ({
  id, owner_id: ownerId, revision: '1', configuration_json: targetConfiguration(profileId), profile_id: profileId,
  paired: true, revoked: false, dedicated_binding: false, pairing_generation: '3',
  created_at: '2026-11-17T00:00:00Z', sort_created_at: '2026-11-17T00:00:00.000000Z',
});

type Kind = 'targets' | 'targetById' | 'executors' | 'profiles' | 'counts' | 'subscriptions';
interface Rows {
  readonly targets?: readonly unknown[];
  readonly targetById?: readonly unknown[];
  readonly executors?: readonly unknown[];
  readonly profiles?: readonly unknown[];
  readonly counts?: readonly unknown[];
  readonly subscriptions?: readonly unknown[];
}

function classify(sql: string): Kind {
  if (sql.includes('sort_created_at') && sql.includes('automation_executors')) return 'executors';
  if (sql.includes('sort_created_at') && sql.includes('automation_targets')) return 'targets';
  if (sql.includes('automation_event_subscriptions')) return 'subscriptions';
  if (sql.includes('GROUP BY profile_id')) return 'counts';
  if (sql.includes('automation_connection_profiles')) return 'profiles';
  if (sql.includes('automation_targets') && sql.includes('id IN')) return 'targetById';
  throw new Error(`unexpected query: ${sql}`);
}

function store(rows: Rows, eventsEnabled?: boolean) {
  const verifyBinding = vi.fn(async () => ({ dedicated: false }));
  const kinds: Kind[] = [];
  const pool = {
    connect: async () => ({
      async query(sql: string) {
        const kind = classify(sql);
        kinds.push(kind);
        const result = rows[kind] ?? [];
        return { command: 'SELECT', rowCount: result.length, rows: result };
      },
      release() {},
    }),
    end: async () => {},
    options: {},
    Client: class {},
  };
  const db = new Kysely<never>({ dialect: new PostgresDialect({ pool: pool as never }) });
  return { store: createTargetStore(db as unknown as DatabaseTransaction, ownerId, verifyBinding, eventsEnabled), kinds, verifyBinding };
}

test('target list resolves one page with constant queries instead of per-row N+1', async () => {
  const rows = {
    targets: [targetRow('t1', 'p1'), targetRow('t2', 'p1'), targetRow('t3', 'p1')],
    profiles: [profileRow('p1')],
    counts: [{ profile_id: 'p1', count: 3 }],
    subscriptions: [{ target_id: 't1', n: 2 }],
  };
  const { store: targetStore, kinds, verifyBinding } = store(rows);
  const entries = await targetStore.targets.list(null, 50);

  expect(entries.map(entry => entry.createdAt)).toEqual([
    '2026-11-17T00:00:00.000000Z', '2026-11-17T00:00:00.000000Z', '2026-11-17T00:00:00.000000Z',
  ]);
  expect(kinds).toEqual(['targets', 'profiles', 'counts', 'subscriptions']);
  expect(verifyBinding).toHaveBeenCalledOnce();
  expect(entries[0]!.view).toEqual({
    id: 't1', revision: '1', configuration: targetConfiguration('p1'), status: 'active', subscriptionCount: 2,
    isolation: 'sharedCredential', wakeMode: 'events', wakeReadiness: 'active',
    wakeReason: 'Verified subscription available; receipt and job execution are separate.',
  });
  expect(entries[1]!.view).toMatchObject({
    id: 't2', status: 'awaitingSubscription', subscriptionCount: 0, wakeReadiness: 'waitingForSubscription',
  });
});

test('target list verifies the binding once per distinct profile', async () => {
  const rows = {
    targets: [targetRow('t1', 'p1'), targetRow('t2', 'p2')],
    profiles: [profileRow('p1'), profileRow('p2')],
    counts: [{ profile_id: 'p1', count: 1 }, { profile_id: 'p2', count: 1 }],
  };
  const { store: targetStore, kinds, verifyBinding } = store(rows);
  const entries = await targetStore.targets.list(null, 50);

  expect(entries).toHaveLength(2);
  expect(kinds).toEqual(['targets', 'profiles', 'counts', 'subscriptions']);
  expect(verifyBinding).toHaveBeenCalledTimes(2);
});

test('eventsEnabled=false preserves blocked views without a subscription query', async () => {
  const rows = {
    targets: [targetRow('t1', 'p1')],
    profiles: [profileRow('p1')],
    counts: [{ profile_id: 'p1', count: 1 }],
  };
  const { store: targetStore, kinds, verifyBinding } = store(rows, false);
  const [entry] = await targetStore.targets.list(null, 50);

  expect(kinds).toEqual(['targets', 'profiles', 'counts']);
  expect(verifyBinding).toHaveBeenCalledOnce();
  expect(entry!.view).toMatchObject({
    id: 't1', status: 'awaitingSubscription', subscriptionCount: 0,
    wakeReadiness: 'blocked', wakeReason: 'Events delivery is disabled on this server.',
  });
});

test('executor list loads its targets once for the whole page', async () => {
  const executor = (id: string, targetId: string) => ({
    id, owner_id: ownerId, revision: '2',
    configuration_json: { name: id, kind: 'mcpEventsBot', dataLocation: 'thirdParty', providerLabel: '', capabilities: [], targetId },
    created_at: '2026-11-17T00:00:00Z', sort_created_at: '2026-11-17T00:00:00.000000Z',
  });
  const rows = {
    executors: [executor('e1', 't1'), executor('e2', 't2')],
    targetById: [targetRow('t1', 'p1'), targetRow('t2', 'p1')],
    profiles: [profileRow('p1')],
    counts: [{ profile_id: 'p1', count: 2 }],
    subscriptions: [{ target_id: 't1', n: 1 }, { target_id: 't2', n: 1 }],
  };
  const { store: targetStore, kinds, verifyBinding } = store(rows);
  const entries = await targetStore.executors.list(null, 50);

  expect(kinds).toEqual(['executors', 'targetById', 'profiles', 'counts', 'subscriptions']);
  expect(verifyBinding).toHaveBeenCalledOnce();
  expect(entries.map(entry => entry.view.status)).toEqual(['available', 'available']);
});
