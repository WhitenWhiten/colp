import { Kysely, PostgresDialect } from 'kysely';
import { expect, test, vi } from 'vitest';
import type { ConnectionProfileInput, TargetInput } from '@know-n/colp/automation';
import { createTargetStore } from '../../../src/infrastructure/automation/target-store.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';

const ownerId = 'owner';
const otherOwnerId = 'other-owner';
const profileConfiguration = (id: string) => ({
  name: id, authorizedClientId: `client-${id}`, credentialBindingId: `binding-${id}`,
  automationEnabled: true, catalogs: ['automationWorker'],
}) as ConnectionProfileInput;
const targetConfiguration = (profileId: string, privacy: 'standard' | 'restricted' = 'standard') => ({
  name: 'worker', providerLabel: '', broadcastOptIn: false, privacy,
  connectionProfileId: profileId, wakeMode: 'events',
}) as TargetInput;
const profileRow = (id: string, owner = ownerId) => ({
  id, owner_id: owner, revision: '7', configuration_json: profileConfiguration(id),
  observation_json: { accountId: owner } as Record<string, unknown>, created_at: '2026-11-17T00:00:00Z',
});
interface TargetRowOptions {
  readonly owner?: string;
  readonly privacy?: 'standard' | 'restricted';
  readonly dedicatedBinding?: boolean;
}
const targetRow = (id: string, profileId: string, options: TargetRowOptions = {}) => ({
  id, owner_id: options.owner ?? ownerId, revision: '1',
  configuration_json: targetConfiguration(profileId, options.privacy),
  profile_id: profileId, paired: true, revoked: false,
  dedicated_binding: options.dedicatedBinding ?? false, pairing_generation: '3',
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
interface Query {
  readonly kind: Kind;
  readonly sql: string;
  readonly parameters: readonly unknown[];
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

/** The acting owner bound by a query's `owner_id=$n` predicate, or undefined when unscoped. */
function ownerParameter(sql: string, parameters: readonly unknown[]): unknown {
  const match = /owner_id\s*=\s*\$(\d+)/u.exec(sql);
  return match === null ? undefined : parameters[Number(match[1]) - 1];
}

function store(rows: Rows, eventsEnabled?: boolean, dedicated = false) {
  const verifyBinding = vi.fn(async () => ({ dedicated }));
  const queries: Query[] = [];
  const pool = {
    connect: async () => ({
      async query(sql: string, parameters: readonly unknown[] = []) {
        const kind = classify(sql);
        queries.push({ kind, sql, parameters });
        // Every read in the target store must be owner-scoped. Rows carrying
        // another owner's id are only returned when the SQL predicate is bound
        // to that other owner, which the assertions below reject.
        const owner = ownerParameter(sql, parameters);
        const result = (rows[kind] ?? []).filter(row =>
          (row as { owner_id?: string }).owner_id === undefined
          || (row as { owner_id?: string }).owner_id === owner);
        return { command: 'SELECT', rowCount: result.length, rows: result };
      },
      release() {},
    }),
    end: async () => {},
    options: {},
    Client: class {},
  };
  const db = new Kysely<never>({ dialect: new PostgresDialect({ pool: pool as never }) });
  return {
    store: createTargetStore(db as unknown as DatabaseTransaction, ownerId, verifyBinding, eventsEnabled),
    queries,
    kinds: () => queries.map(query => query.kind),
    verifyBinding,
  };
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
  expect(kinds()).toEqual(['targets', 'profiles', 'counts', 'subscriptions']);
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
  expect(kinds()).toEqual(['targets', 'profiles', 'counts', 'subscriptions']);
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

  expect(kinds()).toEqual(['targets', 'profiles', 'counts']);
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

  expect(kinds()).toEqual(['executors', 'targetById', 'profiles', 'counts', 'subscriptions']);
  expect(verifyBinding).toHaveBeenCalledOnce();
  expect(entries.map(entry => entry.view.status)).toEqual(['available', 'available']);
});

test('a dedicated binding on the only target isolates restricted work', async () => {
  const rows = {
    targets: [targetRow('t1', 'p1', { privacy: 'restricted' })],
    profiles: [profileRow('p1')],
    counts: [{ profile_id: 'p1', count: 1, owner_id: ownerId }],
    subscriptions: [{ target_id: 't1', n: 1, owner_id: ownerId }],
  };
  const { store: targetStore } = store(rows, undefined, true);
  const [entry] = await targetStore.targets.list(null, 50);

  // The row's persisted dedicated_binding is false; the verified single-target
  // binding is what admits restricted work and the dedicated isolation class.
  expect(entry!.view).toMatchObject({
    id: 't1', status: 'active', isolation: 'dedicatedCredential',
    wakeReadiness: 'active', subscriptionCount: 1,
  });
  expect(entry!.view.wakeMode).toBe('events');
});

test('a dedicated binding shared by two targets blocks restricted work', async () => {
  const rows = {
    targets: [targetRow('t1', 'p1', { privacy: 'restricted' }), targetRow('t2', 'p1')],
    profiles: [profileRow('p1')],
    counts: [{ profile_id: 'p1', count: 2, owner_id: ownerId }],
  };
  const { store: targetStore } = store(rows, undefined, true);
  const entries = await targetStore.targets.list(null, 50);

  expect(entries[0]!.view).toMatchObject({
    id: 't1', status: 'error', isolation: 'sharedCredential',
    wakeReadiness: 'blocked',
    // A shared binding cannot satisfy restricted work: the credential-authority
    // reason wins over the restricted-binding reason in targetView.
    wakeReason: 'Current credential authority is unavailable; reconnect or re-pair.',
  });
  // The standard target on the same profile still resolves as shared.
  expect(entries[1]!.view).toMatchObject({
    id: 't2', status: 'awaitingSubscription', isolation: 'sharedCredential',
  });
});

test("another owner's profile, target, and subscription rows never influence the caller's view", async () => {
  const rows = {
    targets: [
      targetRow('t1', 'p1'),
      targetRow('t-other', 'p-other', { owner: otherOwnerId }),
    ],
    profiles: [profileRow('p1'), profileRow('p-other', otherOwnerId)],
    counts: [
      { profile_id: 'p1', count: 1, owner_id: ownerId },
      // If the grouped count leaked across owners, this caller profile would
      // look shared and its target would flip to sharedCredential.
      { profile_id: 'p1', count: 2, owner_id: otherOwnerId },
    ],
    subscriptions: [
      { target_id: 't1', n: 1, owner_id: ownerId },
      { target_id: 't1', n: 5, owner_id: otherOwnerId },
      { target_id: 't-other', n: 9, owner_id: otherOwnerId },
    ],
  };
  const { store: targetStore, queries } = store(rows);
  const entries = await targetStore.targets.list(null, 50);

  expect(entries.map(entry => entry.view.id)).toEqual(['t1']);
  expect(entries[0]!.view).toMatchObject({
    id: 't1', status: 'active', subscriptionCount: 1, isolation: 'sharedCredential',
  });
  // Even a verified dedicated binding cannot come from the other owner's
  // profile: the profile lookup is owner-scoped as well.
  const grouped = queries.filter(query => query.kind === 'counts' || query.kind === 'subscriptions');
  expect(grouped).toHaveLength(2);
  for (const query of grouped) {
    expect(ownerParameter(query.sql, query.parameters), query.kind).toBe(ownerId);
  }
  // Grouped queries carry the owner predicate in SQL, not just in the fixture.
  expect(queries.find(query => query.kind === 'counts')!.sql)
    .toMatch(/WHERE owner_id=\$\d+ AND profile_id IN/u);
  expect(queries.find(query => query.kind === 'subscriptions')!.sql)
    .toMatch(/s\.owner_id=\$\d+/u);
  expect(queries.find(query => query.kind === 'subscriptions')!.sql)
    .toMatch(/t\.owner_id=s\.owner_id/u);
  expect(queries.find(query => query.kind === 'subscriptions')!.sql)
    .toMatch(/p\.owner_id=t\.owner_id/u);
  for (const query of queries.filter(candidate => candidate.kind === 'targets' || candidate.kind === 'profiles')) {
    expect(ownerParameter(query.sql, query.parameters), query.kind).toBe(ownerId);
  }
});
