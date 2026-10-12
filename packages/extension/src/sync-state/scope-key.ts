import {
  SyncStateError, type Environment, type JsonObject, type Lifecycle, type ScopeRecord, type SyncScope,
  type DiscoveredRoot,
} from './types.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';

export const SCOPE_FIELDS = ['environment', 'serverId', 'serverOrigin', 'accountId', 'browserProfileId',
  'collectionId', 'replicaId', 'generation'] as const;

export function scopeKey(scope: SyncScope) { return JSON.stringify(SCOPE_FIELDS.map((field) => scope[field])); }
export function validLifecycleTransition(from: Lifecycle, to: Lifecycle) {
  if (from === to) return true;
  return (from === 'new' && to === 'active')
    || (from === 'active' && ['expired', 'recovery_required', 'retired'].includes(to))
    || (from === 'expired' && ['active', 'recovery_required', 'retired'].includes(to))
    || (from === 'recovery_required' && ['active', 'retired'].includes(to));
}

export function validateScope(input: unknown): SyncScope {
  const value = strictObject(clone(input), [...SCOPE_FIELDS], 'scope');
  const environment = value.environment;
  if (!['development', 'staging', 'production', 'legacy'].includes(String(environment))) throw new SyncStateError('environment_invalid');
  const serverOrigin = boundedString(value.serverOrigin, 'serverOrigin');
  if (environment !== 'legacy') {
    const url = new URL(serverOrigin);
    // Store builds stay HTTPS. Loopback HTTP is the external e2e server and a local insecure origin.
    const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!loopbackHttp && url.protocol !== 'https:') || url.origin !== serverOrigin) throw new SyncStateError('server_origin_invalid');
  }
  return { environment: environment as Environment, serverId: boundedString(value.serverId, 'serverId'), serverOrigin,
    accountId: boundedString(value.accountId, 'accountId'), browserProfileId: boundedString(value.browserProfileId, 'browserProfileId'),
    collectionId: boundedString(value.collectionId, 'collectionId'), replicaId: boundedString(value.replicaId, 'replicaId'),
    generation: safeInteger(value.generation, 'generation', 1) };
}

export function validateScopeRecord(input: unknown, maxBytes: number): ScopeRecord {
  const value = strictObject(clone(input), [...SCOPE_FIELDS, 'scopeKey', 'lifecycle', 'lease', 'checkpoint',
    'selectedRoots', 'privateRoots', 'rootStatus', 'metadata', 'mountMode', 'boundaryVersion', 'firstRun',
    'legacyCanonicalRoot'], 'scope record', ['scopeKey', 'privateRoots', 'rootStatus', 'metadata', 'mountMode',
    'boundaryVersion', 'firstRun', 'legacyCanonicalRoot']);
  const scope = validateScope(Object.fromEntries(SCOPE_FIELDS.map((field) => [field, value[field]])));
  const lifecycle = String(value.lifecycle) as Lifecycle;
  if (!['new', 'active', 'expired', 'recovery_required', 'retired'].includes(lifecycle)) throw new SyncStateError('lifecycle_invalid');
  const lease = strictObject(value.lease, ['leaseId', 'expiresAt', 'generation'], 'lease', ['generation']);
  const checkpoint = value.checkpoint === null ? null : strictObject(value.checkpoint, ['serverRevision', 'cursor'], 'checkpoint');
  if (!Array.isArray(value.selectedRoots) || value.selectedRoots.length > 128) throw new SyncStateError('selected_roots_invalid');
  if (value.privateRoots !== undefined && (!Array.isArray(value.privateRoots) || value.privateRoots.length > 128)) {
    throw new SyncStateError('private_roots_invalid');
  }
  const rootStatus = value.rootStatus === undefined ? 'ready' : String(value.rootStatus);
  if (!['ready', 'nested_normalized', 'root_missing', 'permission_required', 'tree_unavailable', 'corrupt'].includes(rootStatus)) {
    throw new SyncStateError('root_status_invalid');
  }
  const mountMode = value.mountMode === undefined ? 'whole-profile' : String(value.mountMode);
  if (mountMode !== 'whole-profile' && mountMode !== 'mounted-folder') throw new SyncStateError('mount_mode_invalid');
  const firstRun = value.firstRun === undefined ? 'none' : String(value.firstRun);
  if (!['none', 'deferred', 'running', 'completed'].includes(firstRun)) throw new SyncStateError('first_run_invalid');
  const record: ScopeRecord = { ...scope, scopeKey: scopeKey(scope), lifecycle,
    lease: { leaseId: boundedString(lease.leaseId, 'leaseId'), expiresAt: safeInteger(lease.expiresAt, 'expiresAt'),
      ...(lease.generation === undefined ? {} : { generation: boundedString(lease.generation, 'leaseGeneration') }) },
    checkpoint: checkpoint ? { serverRevision: boundedString(checkpoint.serverRevision, 'serverRevision'),
      cursor: boundedString(checkpoint.cursor, 'cursor') } : null,
    selectedRoots: value.selectedRoots.map((item) => boundedString(item, 'selectedRoot')),
    privateRoots: (value.privateRoots ?? []).map((item: unknown) => boundedString(item, 'privateRoot')),
    rootStatus: rootStatus as NonNullable<ScopeRecord['rootStatus']>,
    mountMode: mountMode as ScopeRecord['mountMode'],
    boundaryVersion: value.boundaryVersion === undefined ? '0' : boundedString(value.boundaryVersion, 'boundaryVersion', 64),
    firstRun: firstRun as NonNullable<ScopeRecord['firstRun']>,
    ...(value.legacyCanonicalRoot === undefined ? {} : {
      legacyCanonicalRoot: boundedString(value.legacyCanonicalRoot, 'legacyCanonicalRoot') }),
    ...(value.metadata === undefined ? {} : { metadata: validateJson(value.metadata, 'metadata') as JsonObject }) };
  validateRecord(record, maxBytes); return record;
}

export function validateAccountScope(input: unknown) { const value = strictObject(clone(input), ['environment', 'serverId', 'accountId', 'browserProfileId'], 'account scope');
  if (!['development', 'staging', 'production', 'legacy'].includes(String(value.environment))) throw new SyncStateError('environment_invalid');
  return { environment: value.environment as Environment, serverId: boundedString(value.serverId, 'serverId'),
    accountId: boundedString(value.accountId, 'accountId'), browserProfileId: boundedString(value.browserProfileId, 'browserProfileId') }; }

export function validateDiscovered(input: readonly DiscoveredRoot[]): Map<string, readonly string[]> {
  if (!Array.isArray(input) || input.length > 50_000) throw new SyncStateError('discovered_roots_invalid');
  const result = new Map<string, readonly string[]>();
  for (const raw of input) {
    const value = strictObject(clone(raw), ['nativeId', 'ancestorNativeIds'], 'discovered root');
    const nativeId = boundedString(value.nativeId, 'nativeId');
    if (!Array.isArray(value.ancestorNativeIds) || value.ancestorNativeIds.length > 1_024 || result.has(nativeId)) {
      throw new SyncStateError('discovered_roots_invalid');
    }
    const ancestors = value.ancestorNativeIds.map((item) => boundedString(item, 'ancestorNativeId'));
    if (new Set(ancestors).size !== ancestors.length || ancestors.includes(nativeId)) throw new SyncStateError('discovered_roots_invalid');
    result.set(nativeId, ancestors);
  }
  for (const ancestors of result.values()) for (const ancestor of ancestors) {
    if (!result.has(ancestor)) throw new SyncStateError('discovered_roots_invalid');
  }
  return result;
}

export function normalizeBoundaries(input: readonly string[], discovered: ReadonlyMap<string, readonly string[]>): string[] {
  if (!Array.isArray(input) || input.length > 128) throw new SyncStateError('root_selection_invalid');
  const selected = new Set(input.map((item) => boundedString(item, 'selectedNativeId')));
  for (const nativeId of selected) if (!discovered.has(nativeId)) throw new SyncStateError('root_selection_unknown');
  return [...selected].filter((nativeId) => !discovered.get(nativeId)!.some((ancestor) => selected.has(ancestor)));
}
