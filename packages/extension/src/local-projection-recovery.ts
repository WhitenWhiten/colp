import type { EngineOptions } from './durable-sync-engine-types.js';
import { leftoverVirtualChildrenNeedReproject, unprotectedProjectionIntents } from './recovery-guard.js';
import { PROJECTABLE_NATIVE_PREFIX } from './recovery-projection-executor.js';
import type { MappingReadContext } from './sync-state/mapping-repository.js';
import type { MappingInput } from './sync-state-store.js';

// The owner is the claiming engine revision, scoped by the durable record's key
// (including replica/profile/generation). Protocol recovery writes omit it.
export async function resumeLocalProjection(options: Pick<EngineOptions, 'store' | 'scope' | 'now' | 'snapshotProjector'>,
  authority: EngineOptions['sessions']['get'], mappingReads?: MappingReadContext): Promise<void> {
  const { store, scope } = options;
  const now = options.now ?? Date.now;
  const initial = await store.getEngineState(scope);
  if (!initial || initial.recoveryFrozen && initial.localProjectionOwner === undefined) return;
  // Work needs a `recovery:` mapping or a live projection intent. Most wakes have neither,
  // so they skip the whole-library mapping read and the issue scans below.
  if (initial.localProjectionOwner === undefined && store.hasMappingNativePrefix
      && !await store.hasMappingNativePrefix(scope, PROJECTABLE_NATIVE_PREFIX)
      && !(await store.listProjectionIntents(scope)).some(intent => intent.state !== 'terminal')) return;
  const readMappings = async () => mappingReads?.read() ?? store.listMappings(scope);
  let mappings = await readMappings();
  const pending = (rows: readonly MappingInput[]) => unprotectedProjectionIntents(store, scope, rows);
  const needsProjection = await leftoverVirtualChildrenNeedReproject(store, scope, mappings)
    || (await pending(mappings)).length > 0;
  if (!needsProjection && initial.localProjectionOwner === undefined) return;
  if (!await eligible()) return;
  const claimed = initial.localProjectionOwner !== undefined ? initial : await store.transitionEngine(scope, {
    ...initial, phase: 'applying', recoveryFrozen: true, localProjectionOwner: initial.revision + 1,
    expectedRevision: initial.revision, updatedAt: now(),
  });
  if (needsProjection) {
    await options.snapshotProjector(mappings.map(stripScopeKey));
    mappingReads?.invalidate();
    mappings = await readMappings();
  }
  // A projector can freeze identity/protocol authority while performing native
  // work. Never consume that freeze, or a concurrent engine revision.
  if ((await pending(mappings)).length > 0 || !await eligible()) return;
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

function stripScopeKey(mapping: MappingInput): MappingInput {
  const { scopeKey: _scopeKey, ...row } = mapping as MappingInput & { readonly scopeKey?: string };
  return row;
}
