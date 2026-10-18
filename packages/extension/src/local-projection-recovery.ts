import type { EngineOptions } from './durable-sync-engine-types.js';
import { leftoverVirtualChildrenNeedReproject, unprotectedProjectionIntents } from './recovery-guard.js';

// The owner is the claiming engine revision, scoped by the durable record's key
// (including replica/profile/generation). Protocol recovery writes omit it.
export async function resumeLocalProjection(options: Pick<EngineOptions, 'store' | 'scope' | 'now' | 'snapshotProjector'>,
  authority: EngineOptions['sessions']['get']): Promise<void> {
  const { store, scope } = options;
  const now = options.now ?? Date.now;
  const initial = await store.getEngineState(scope);
  if (!initial || initial.recoveryFrozen && initial.localProjectionOwner === undefined) return;
  const pending = async () => (await unprotectedProjectionIntents(store, scope)).length > 0;
  const needsProjection = await leftoverVirtualChildrenNeedReproject(store, scope) || await pending();
  if (!needsProjection && initial.localProjectionOwner === undefined) return;
  if (!await eligible()) return;
  const claimed = initial.localProjectionOwner !== undefined ? initial : await store.transitionEngine(scope, {
    ...initial, phase: 'applying', recoveryFrozen: true, localProjectionOwner: initial.revision + 1,
    expectedRevision: initial.revision, updatedAt: now(),
  });
  if (needsProjection) {
    const mappings = (await store.listMappings(scope)).map(({ scopeKey: _key, ...mapping }) => mapping);
    await options.snapshotProjector(mappings);
  }
  // A projector can freeze identity/protocol authority while performing native
  // work. Never consume that freeze, or a concurrent engine revision.
  if (await pending() || !await eligible()) return;
  const current = await store.getEngineState(scope);
  if (!current || current.revision !== claimed.revision
      || current.localProjectionOwner !== claimed.localProjectionOwner) return;
  const { localProjectionOwner: _owner, connectivityConfirmationRevision: _confirmation, ...rest } = current;
  await store.transitionEngine(scope, { ...rest, phase: 'applying', recoveryFrozen: false,
    expectedRevision: claimed.revision, updatedAt: now() });

  async function eligible(): Promise<boolean> {
    const session = (await authority()).session;
    const [record, engine, acks, staging] = await Promise.all([
      store.getScope(scope), store.getEngineState(scope), store.listAckIntents(scope), store.hasRecoveryStaging(scope),
    ]);
    return record?.lifecycle === 'active' && record.generation === scope.generation
      && record.lease.leaseId === session.replicaLease.leaseId
      && (record.lease.generation === undefined || record.lease.generation === session.replicaLease.generation)
      && session.replicaLease.state === 'active' && !session.snapshotRequired
      && !engine?.authorityRefreshRequired && !staging
      && acks.some((ack) => ack.kind === 'bootstrap' && ack.state === 'complete')
      && !acks.some((ack) => ack.kind === 'bootstrap' && ack.state !== 'complete');
  }
}
