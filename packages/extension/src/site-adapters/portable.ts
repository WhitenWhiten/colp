import { sameDestinationOwner } from './copy-identity.js';
import { legacySite, identityDefinition, type SiteDefinition } from './registry.js';
import { readConnectionAuthority, authorityForConnection } from './ledger.js';
import { readSourceConnection } from './content-identity.js';
import type { Representation, SourceFolderReservation } from './contracts.js';
import type { SourceAuthority, SourceConnection } from './ledger-types.js';
import type { SourceMount, SourcePolicyRecord, LayoutNativeNode } from './layout.js';
import { get, put, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import { cursorPage } from '../sync-state/idb.js';
import { array, literal, object, str, jsonBytes } from './schema.js';
import { representationKey } from './reservations.js';

interface PortableAssociation { itemId: string; collectionId: string | null; mountRef: string | null; purpose: 'sourceArchive' | 'semantic';
  nativeSourceId: string | null; state: 'active' | 'detached' | 'suppressed'; scopeRef?: string }
interface PortableMount { ref: string; rootSourceId: string | null; aiDestination: 'excluded' | 'allowed';
  folders: { collectionId: string; nativeSourceId: string | null; state: string }[] }
export interface PortableSources { version: 1 | 2 | 3; connections: { ref: string; siteKey?: string; accountId: string; identityVersion: number;
  copies: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting'; mounts: PortableMount[]; associations: PortableAssociation[] }[] }
const nullable = (v: unknown) => v === null || str(256)(v);
const association = object({ itemId: str(128), collectionId: nullable, mountRef: nullable,
  scopeRef: v => v === undefined || str(128)(v), purpose: literal('sourceArchive', 'semantic'), nativeSourceId: nullable, state: literal('active', 'detached', 'suppressed') }, v => {
  const a = v as PortableAssociation; return a.purpose === 'semantic' ? a.collectionId === null && a.mountRef === null : !!a.collectionId && !!a.mountRef;
});
const mountSchema = object({ ref: str(256), rootSourceId: nullable, aiDestination: literal('excluded', 'allowed'),
  folders: array(object({ collectionId: str(256), nativeSourceId: nullable, state: literal('reserved', 'submitted', 'unknown', 'confirmed', 'blocked') }), 100_000, 0, v => (v as { collectionId: string }).collectionId) });
export function parsePortableSources(value: unknown): PortableSources {
  if (!jsonBytes(value, 32 * 1024 * 1024) || !object({ version: literal(1, 2, 3), connections: array(object({ ref: str(256),
    siteKey: v => v === undefined || str(128)(v), accountId: str(128), identityVersion: v => Number.isSafeInteger(v) && Number(v) > 0,
    copies: literal('sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting'), mounts: array(mountSchema, 1000, 0, v => (v as PortableMount).ref),
    associations: array(association, 100_000) }), 1000, 0, v => (v as { ref: string }).ref) })(value)) throw new Error('sourceBackupInvalid');
  const result = value as PortableSources;
  for (const c of result.connections) {
    if (result.version === 1 && (c.siteKey !== undefined || c.identityVersion !== legacySite.identityVersion || !legacySite.validateAccount(c.accountId)) || result.version >= 2 && !c.siteKey) throw new Error('sourceBackupInvalid');
    if (c.associations.some(a => result.version < 3 ? a.scopeRef !== undefined : a.purpose === 'semantic' && !a.scopeRef)) throw new Error('sourceBackupInvalid');
    if (new Set(c.associations.map(a => sourceKey(a.itemId, a.purpose, a.collectionId, a.mountRef, a.scopeRef ?? null))).size !== c.associations.length
      || c.associations.some(a => a.mountRef && !c.mounts.some(m => m.ref === a.mountRef))) throw new Error('sourceBackupInvalid');
  }
  return structuredClone(result);
}
async function all<T>(db: SourceDatabase, store: 'connections' | 'mounts' | 'representations' | 'folderReservations' | 'meta', range: IDBKeyRange | null = null) {
  const values = await db.transaction([store], 'readonly', tx => cursorPage<T>(tx.objectStore(store), range, 100001));
  if (values.length > 100000) throw new Error('sourceBackupLimit'); return values;
}
/** Several rules may reference one stable mapping; export that mapping only once. */
function portableMounts(mounts: readonly SourceMount[]) {
  const unique = new Map<string, SourceMount>();
  for (const mount of mounts) {
    const old = unique.get(mount.id);
    if (old && (old.root.nativeId !== mount.root.nativeId || old.root.dateAdded !== mount.root.dateAdded
      || old.root.deviceId !== mount.root.deviceId || !sameDestinationOwner(old.destination, mount.destination))) throw new Error('sourceBackupInvalid');
    unique.set(mount.id, old ? { ...mount, aiDestination: old.aiDestination === 'excluded' || mount.aiDestination === 'excluded' ? 'excluded' : 'allowed' } : mount);
  }
  return [...unique.values()];
}
/** Foreign native IDs are source references only. Executable plans, generations and grants never travel. */
export async function exportPortableSources(db: SourceDatabase, nativeSourceIds: ReadonlySet<string>): Promise<PortableSources | undefined> {
  const [connections, mounts, reps, folders] = await Promise.all([all<SourceConnection>(db, 'connections'), all<SourceMount>(db, 'mounts'),
    all<Representation>(db, 'representations'), all<SourceFolderReservation>(db, 'folderReservations')]);
  const sourceRef = (id: string | undefined) => id && nativeSourceIds.has(id) ? id : null;
  const result: PortableSources = { version: 3, connections: [] };
  for (const c of connections) {
    const policy = await db.read<SourcePolicyRecord>('meta', `policy:${c.id}`);
    result.connections.push({ ref: c.id, siteKey: c.siteKey ?? legacySite.siteKey, accountId: c.accountId, identityVersion: c.identityVersion, copies: policy?.policy.copies ?? 'sourceAndSemantic',
      mounts: portableMounts(mounts.filter(m => m.connectionId === c.id)).map(m => ({ ref: m.id, rootSourceId: sourceRef(m.root.nativeId), aiDestination: m.aiDestination,
        folders: folders.filter(f => f.mountId === m.id).map(f => ({ collectionId: f.collectionId, nativeSourceId: sourceRef(f.native?.nativeId), state: f.state })) })),
      associations: reps.filter(r => r.connectionId === c.id).map(r => ({ itemId: r.itemId, collectionId: r.sourceCollectionId, mountRef: r.mountId,
        purpose: r.purpose, nativeSourceId: sourceRef(r.native.nativeId), state: r.state,
        ...(r.purpose === 'semantic' ? { scopeRef: sourceDigest(r.scopeId ?? ['legacy', r.native.deviceId]) } : {}) })) });
  }
  // A second backup must also preserve associations still awaiting review after the first restore.
  const inert = (await all<unknown>(db, 'meta', IDBKeyRange.bound('restoredSources:', 'restoredSources:\uffff'))).filter((v): v is RestoredSources => !!v && typeof v === 'object' && 'data' in v && 'nativeIds' in v && 'reviewed' in v && (v as RestoredSources).state === 'disabled');
  for (const restore of inert) for (const c of restore.data.connections) {
    const blocked = restore.reviewed.includes(sourceKey(c.ref, '__blocked__'));
    const pending = c.mounts.filter(m => blocked || !restore.reviewed.includes(sourceKey(c.ref, m.ref)));
    const associations = c.associations.filter(r => !r.mountRef || pending.some(m => m.ref === r.mountRef));
    if (!pending.length && !associations.length) continue;
    const mapRef = (ref: string) => sourceDigest([restore.id, c.ref, ref]);
    const mapNative = (ref: string | null) => ref && Object.hasOwn(restore.nativeIds, ref) ? sourceRef(restore.nativeIds[ref]) : null;
    result.connections.push({ ref: sourceDigest([restore.id, c.ref]), siteKey: c.siteKey ?? legacySite.siteKey, accountId: c.accountId, identityVersion: c.identityVersion, copies: c.copies,
      mounts: pending.map(m => ({ ...m, ref: mapRef(m.ref), rootSourceId: mapNative(m.rootSourceId), folders: m.folders.map(f => ({ ...f, nativeSourceId: mapNative(f.nativeSourceId) })) })),
      associations: associations.map(r => ({ ...r, ...(r.purpose === 'semantic' ? { scopeRef: r.scopeRef ?? sourceDigest([restore.id, c.ref, 'legacy']) } : {}), mountRef: r.mountRef && mapRef(r.mountRef), nativeSourceId: mapNative(r.nativeSourceId) })) });
  }
  if (!result.connections.length) return undefined;
  return parsePortableSources(result);
}
export interface RestoredSources { id: string; data: PortableSources; nativeIds: Record<string, string>; state: 'disabled'; reviewed: string[] }
export async function restorePortableSources(db: SourceDatabase, id: string, data: PortableSources, nativeIds: ReadonlyMap<string, string>) {
  const parsed = parsePortableSources(data);
  await db.transaction(['meta'], 'readwrite', async tx => {
    const key = `restoredSources:${id}`, old = await get<RestoredSources>(tx, 'meta', key);
    const mapping = Object.fromEntries(nativeIds);
    if (old) { if (sourceDigest(old.data) !== sourceDigest(parsed) || sourceDigest(old.nativeIds) !== sourceDigest(mapping)) throw new Error('sourceRestoreConflict'); return; }
    put(tx, 'meta', key, { id, data: parsed, nativeIds: mapping, state: 'disabled', reviewed: [] } satisfies RestoredSources);
    for (const c of parsed.connections) {
      const gate = accountGate(c), ids = await get<string[]>(tx, 'meta', gate) ?? [];
      put(tx, 'meta', gate, [...new Set([...ids, id])]);
    }
  });
}
export async function assertSourceRebound(db: SourceDatabase, connectionId: string) {
  const authority = await readConnectionAuthority(db, connectionId);
  if (authority?.accountId && (await db.read<string[]>('meta', accountGate(await readSourceConnection(db, connectionId))))?.length)
    throw new Error('sourceRestoreRebindRequired');
}
export async function assertRestoredItemAvailable(db: SourceDatabase, connectionId: string, itemId: string, collectionId?: string) {
  if (await db.read('meta', sourceKey('restoredItemBlocked', connectionId, itemId))
    || collectionId && await db.read('meta', sourceKey('restoredCollectionBlocked', connectionId, collectionId))) throw new Error('sourceRestoredCopyNeedsReview');
}
export interface RebindPorts { authority(): Promise<SourceAuthority | undefined>; mount(): Promise<SourceMount | undefined>;
  lookup(id: string): Promise<LayoutNativeNode | null>; deviceId(): Promise<string> }
/** Rebind only exact import-receipt mappings. No URL/title search, native moves or creates. */
export function createSourceRebinder(db: SourceDatabase, ports: RebindPorts, definition: SiteDefinition = legacySite) {
  const matches = (c: PortableSources['connections'][number]) => (c.siteKey ?? legacySite.siteKey) === definition.siteKey && c.identityVersion === definition.identityVersion;
  async function reviewBlocked(id: string, connectionRef: string) {
    const restore = await db.read<RestoredSources>('meta', `restoredSources:${id}`), a = await ports.authority();
    const c = restore?.data.connections.find(c => c.ref === connectionRef);
    if (!restore || !c || !matches(c) || !a?.enabled || !a.connectionId || a.accountId !== c.accountId) throw new Error('sourceRestoreAccountOrRootRequired');
    const payload = { id, connectionRef, connection: c, authority: a, action: 'retainBlockedForManualReview', nativeWrites: 0 };
    return { ...payload, digest: sourceDigest(payload) };
  }
  async function preview(id: string, connectionRef: string, mountRef: string) {
    const restore = await db.read<RestoredSources>('meta', `restoredSources:${id}`), a = await ports.authority(), mount = await ports.mount();
    const c = restore?.data.connections.find(c => c.ref === connectionRef), original = c?.mounts.find(m => m.ref === mountRef);
    if (!restore || !c || !matches(c) || !original || !a?.enabled || !a.connectionId || a.accountId !== c.accountId || !mount || mount.connectionId !== a.connectionId) throw new Error('sourceRestoreAccountOrRootRequired');
    if (original.rootSourceId === null || !Object.hasOwn(restore.nativeIds, original.rootSourceId) || restore.nativeIds[original.rootSourceId] !== mount.root.nativeId) throw new Error('sourceRestoreRootMismatch');
    const deviceId = await ports.deviceId(), root = await ports.lookup(mount.root.nativeId);
    if (mount.state !== 'active' || mount.root.deviceId !== deviceId || root?.url || root?.dateAdded !== mount.root.dateAdded) throw new Error('bindingNeedsRebind');
    const folders: { collectionId: string; node: LayoutNativeNode }[] = [], representations: { association: PortableAssociation; node: LayoutNativeNode }[] = [];
    const review: string[] = [];
    for (const f of original.folders) {
      const nativeId = f.nativeSourceId && Object.hasOwn(restore.nativeIds, f.nativeSourceId) && restore.nativeIds[f.nativeSourceId], node = nativeId ? await ports.lookup(nativeId) : null;
      if (f.state !== 'confirmed' || !node?.dateAdded || node.url || node.parentId !== root!.id) review.push(`collection:${f.collectionId}:unprovenFolder`);
      else folders.push({ collectionId: f.collectionId, node });
    }
    for (const association of c.associations.filter(r => r.mountRef === mountRef)) {
      const nativeId = association.nativeSourceId && Object.hasOwn(restore.nativeIds, association.nativeSourceId) && restore.nativeIds[association.nativeSourceId], node = nativeId ? await ports.lookup(nativeId) : null;
      const folder = folders.find(f => f.collectionId === association.collectionId);
      if (association.state !== 'active' || !node?.dateAdded || node.url !== identityDefinition(c.siteKey ?? legacySite.siteKey, c.identityVersion).itemUrl(association.itemId)
        || node.parentId !== folder?.node.id) review.push(`item:${association.itemId}:${association.state}:manualReview`);
      else representations.push({ association, node });
    }
    // A semantic or unmapped scope cannot be silently discarded when clearing the account gate.
    if (c.associations.some(r => r.mountRef === null)) review.push('semanticAssociationsRequireExplicitAdoption');
    const payload = { id, connectionRef, mountRef, authority: a, mount, deviceId, folders, representations, review };
    return { ...payload, digest: sourceDigest(payload), nativeWrites: 0 as const };
  }
  return { preview, reviewBlocked, async retainBlocked(id: string, connectionRef: string, digest: string) {
    const p = await reviewBlocked(id, connectionRef); if (p.digest !== digest) throw new Error('sourceRestorePreviewStale');
    await db.transaction(['meta', 'authorities'], 'readwrite', async tx => {
      if (sourceDigest(await authorityForConnection(tx, p.authority.connectionId!)) !== sourceDigest(p.authority)) throw new Error('sourceRestorePreviewStale');
      const key = `restoredSources:${id}`, restore = (await get<RestoredSources>(tx, 'meta', key))!;
      for (const r of p.connection.associations) put(tx, 'meta', sourceKey('restoredItemBlocked', p.authority.connectionId, r.itemId), { restoreId: id, connectionRef, state: 'blocked', reason: 'sourceRestoredCopyNeedsReview' });
      for (const m of p.connection.mounts) for (const f of m.folders) put(tx, 'meta', sourceKey('restoredCollectionBlocked', p.authority.connectionId, f.collectionId), { restoreId: id, connectionRef, state: 'blocked', reason: 'sourceRestoredFolderNeedsReview' });
      const reviewed = [...new Set([...restore.reviewed, sourceKey(connectionRef, '__blocked__')])]; put(tx, 'meta', key, { ...restore, reviewed });
      const done = restore.data.connections.filter(c => matches(c) && c.accountId === p.authority.accountId).every(c => reviewed.includes(sourceKey(c.ref, '__blocked__'))
        || c.mounts.length > 0 && !c.associations.some(r => !r.mountRef) && c.mounts.every(m => reviewed.includes(sourceKey(c.ref, m.ref))));
      if (done) { const gate = accountGate({ siteKey: definition.siteKey, identityVersion: definition.identityVersion, accountId: p.authority.accountId! }); put(tx, 'meta', gate, (await get<string[]>(tx, 'meta', gate) ?? []).filter(v => v !== id)); }
    });
    return { state: 'blocked', nativeWrites: 0 };
  }, async approve(id: string, connectionRef: string, mountRef: string, digest: string) {
    const p = await preview(id, connectionRef, mountRef);
    if (p.digest !== digest) throw new Error('sourceRestorePreviewStale');
    if (p.review.length) throw new Error('sourceRestoreManualReviewRequired');
    const binding = <T extends 'bookmark' | 'folder'>(node: LayoutNativeNode, kind: T) => ({ bindingId: crypto.randomUUID(), deviceId: p.deviceId,
      nativeId: node.id, kind, dateAdded: node.dateAdded!, proof: { kind: 'explicitAdoption' as const, id: crypto.randomUUID() } });
    await db.transaction(['meta', 'authorities', 'mounts', 'folderReservations', 'representations', 'itemReservations'], 'readwrite', async tx => {
      if (sourceDigest(await authorityForConnection(tx, p.authority.connectionId!)) !== sourceDigest(p.authority)
        || sourceDigest(await get(tx, 'mounts', sourceKey(p.mount.connectionId, p.mount.rootRuleId))) !== sourceDigest(p.mount)) throw new Error('sourceRestorePreviewStale');
      const key = `restoredSources:${id}`, restore = (await get<RestoredSources>(tx, 'meta', key))!;
      const scope = sourceKey(connectionRef, mountRef); if (restore.reviewed.includes(scope)) return;
      for (const f of p.folders) {
        const key = sourceKey(p.mount.id, f.collectionId);
        if (await get(tx, 'folderReservations', key)) throw new Error('sourceRestoreExistingReservation');
        const input = { mountId: p.mount.id, collectionId: f.collectionId, mountRevision: p.mount.revision, parent: { kind: 'native' as const, binding: p.mount.root }, title: f.node.title };
        put(tx, 'folderReservations', key, { ...input, id: crypto.randomUUID(), commandId: crypto.randomUUID(), payloadDigest: sourceDigest(input), state: 'confirmed', native: binding(f.node, 'folder') } satisfies SourceFolderReservation);
      }
      for (const { association: r, node } of p.representations) {
        const rep: Representation = { connectionId: p.authority.connectionId!, itemId: r.itemId, purpose: r.purpose, sourceCollectionId: r.collectionId,
          mountId: p.mount.id, state: 'active', native: binding(node, 'bookmark'), manualRevision: 0, lastWritten: { title: node.title, parentId: node.parentId!, url: node.url! } };
        const key = representationKey(rep);
        if (await get(tx, 'representations', key) || await get(tx, 'itemReservations', key)) throw new Error('sourceRestoreExistingReservation');
        put(tx, 'representations', key, rep);
      }
      const reviewed = [...restore.reviewed, scope]; put(tx, 'meta', key, { ...restore, reviewed });
      const done = restore.data.connections.filter(c => matches(c) && c.accountId === p.authority.accountId).every(c => c.mounts.length > 0
        && !c.associations.some(r => !r.mountRef) && c.mounts.every(m => reviewed.includes(sourceKey(c.ref, m.ref))));
      if (done) { const gate = accountGate({ siteKey: definition.siteKey, identityVersion: definition.identityVersion, accountId: p.authority.accountId! });
        put(tx, 'meta', gate, (await get<string[]>(tx, 'meta', gate) ?? []).filter(v => v !== id)); }
    });
    return { adopted: p.representations.length, nativeWrites: 0 };
  } };
}

function accountGate(c: { siteKey?: string; identityVersion: number; accountId: string }) {
  const siteKey = c.siteKey ?? legacySite.siteKey;
  return siteKey === legacySite.siteKey && c.identityVersion === legacySite.identityVersion
    ? `restoredAccount:${c.accountId}` : sourceKey('restoredAccount', siteKey, c.identityVersion, c.accountId);
}
