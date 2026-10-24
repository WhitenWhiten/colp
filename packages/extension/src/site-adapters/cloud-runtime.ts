import { legacySite, type SiteDefinition } from './registry.js';
import { installationKey } from './installation.js';
import { captureTarget } from '../sw/capture-target.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { cloudEdgeUnseen, cloudProgress } from './cloud-progress.js';
import { createSourceCloudClient, assertCloudReceipt, type CloudScope, type CloudEdge, type CloudLease, type CloudReceipt } from './cloud-client.js';
import { siteLedger } from './source-runtime.js';
import { get, put, rows, sourceDigest, sourceKey } from './source-db.js';
import { currentSyncScope, loadConfig } from '../sw/scope.js';
import { store, syncState } from '../sw/runtime.js';
import { colpCredentialHeaders } from '../auth-client.js';
import { credentialGatedFetch } from '../server-origin-permission.js';
import { currentFlat, nativeFolderLookup, browserRuleStore } from '../sw/automation-browser.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
import { decideList } from '../automation/rule-list-decide.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertNoCloudDestinationWork } from './layout-runtime.js';
import { withDestinationPolicyBoundary } from '../classification-destination-boundary.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';
import { createLane } from '../automation/lane.js';
import type { SourceAuthority, LedgerEdge } from './ledger-types.js';
import type { SiteCollection, SiteItem } from './contracts.js';
import type { SourcePolicyRecord, SourceMount } from './layout.js';
export function createCloudRuntime(definition: SiteDefinition = legacySite) {
const db = siteLedger.db, lane = createLane();
interface Owner { serverOrigin: string; accountId: string; collectionId: string; replicaId: string; generation: number }
interface Snapshot { owner: Owner; authority: SourceAuthority; scope: CloudScope; nativeRoots: { ruleId: string; nativeId: string; dateAdded: number; path: string }[]; fence: string }
interface RecordState { snapshot: Snapshot; lease: CloudLease; scopeDigest: string; after: string | null; pending: string | null; processed?: Record<string, number>; revoked?: boolean }
interface Plan { planId: string; digest: string; epoch: number; scope: CloudScope; edges: CloudEdge[]; owner: Owner; snapshotFence: string; after: string | null; ordinals?: Record<string, number>;
  state: 'prepared' | 'submitted' | 'unknown' | 'committed' | 'cancelled'; receipt?: CloudReceipt }
const activeKey = (owner: Owner) => installationKey(`sourceCloudActive:${sourceDigest(owner)}`, definition);
const stateKey = (id: string) => `sourceCloud:${id}`, planKey = (id: string) => `sourceCloudPlan:${id}`;
const sameOwner = (a: Owner, b: Owner) => sourceDigest(a) === sourceDigest(b);
async function client() {
  const initialSource = await db.read<SourceAuthority>('authorities', definition.adapterId);
  const owner = await currentSyncScope(), config = await loadConfig(), credential = await store.loadCredential(), authority = await store.fence.read();
  if (!credential || config.serverOrigin !== owner.serverOrigin) throw new Error('not_connected');
  const assertCurrent = async () => { await store.assertWritable(authority.generation); if (!sameOwner(owner, await currentSyncScope())) throw new Error('sourceCloudOwnerChanged'); };
  return { owner, api: createSourceCloudClient({ identity: { site: definition.siteKey, identityVersion: definition.identityVersion }, origin: owner.serverOrigin, fetch: credentialGatedFetch(), assertCurrent, authorize: async action => {
    if (action && ['configure', 'preview', 'commit', 'renew'].includes(action)) {
      const a = await db.read<SourceAuthority>('authorities', definition.adapterId);
      if (!a?.enabled || sourceDigest(a) !== sourceDigest(initialSource)) throw new Error('sourceAuthorizationChanged');
      if (await sourceAutomationsPaused()) throw new Error('sourceAutomationPaused');
      if (action === 'commit') await requireRecord();
    }
  }, headers: async () => colpCredentialHeaders(credential.accessToken) }) };
}
async function snapshot(): Promise<Snapshot> {
  const owner = await currentSyncScope(), authority = await db.read<SourceAuthority>('authorities', definition.adapterId);
  if (!authority?.enabled || !authority.connectionId || !authority.accountId) throw new Error('sourceAuthorizationChanged');
  await assertSourceRebound(db, authority.connectionId);
  const policy = await db.read<SourcePolicyRecord>('meta', `policy:${authority.connectionId}`), flat = await currentFlat();
  if (!policy?.enabled || flat.stopped || await sourceAutomationsPaused()) throw new Error('sourceAutomationPaused');
  if (policy.policy.copies !== 'sourceAndSemantic') throw new Error('sourceCloudCopyPolicyNeedsReview');
  const collections = await db.transaction(['collections'], 'readonly', tx => rows<{ entity: SiteCollection }>(tx, 'collections', authority.connectionId));
  const catalog = collections.map(x => x.entity).filter(c => c.identity === 'siteId');
  const roots: CloudScope['roots'] = [], nativeRoots: Snapshot['nativeRoots'] = [];
  for (const item of flat.items) {
    if (!item.site || item.site.admission.connectionId !== authority.connectionId || !item.site.admission.entries.includes('siteImport') || item.action.kind !== 'file' || !item.action.folderNativeId) continue;
    const id = item.action.folderNativeId, mapping = await syncState.getMappingByNativeId(owner, id);
    if (!mapping || mapping.quarantine || mapping.nodeKind !== 'folder') continue;
    const target = await captureTarget(await currentCaptureScope(), id);
    if (!target.inRange || target.collectionId !== owner.collectionId) throw new Error('sourceCloudMappingNeedsReview');
    const n = (await chrome.bookmarks.get(id).catch(() => []))[0];
    if (!n || n.url || !n.dateAdded || mapping.parentNativeId && mapping.parentNativeId !== n.parentId) throw new Error('sourceCloudMappingNeedsReview');
    const mount = await db.read<SourceMount>('mounts', sourceKey(authority.connectionId, item.id));
    if (!mount || mount.state !== 'active' || mount.root.nativeId !== id || mount.root.dateAdded !== n.dateAdded || mount.root.deviceId !== await captureDeviceId()) throw new Error('sourceCloudMappingNeedsReview');
    const ids = [...item.site.admission.collectionIds ?? catalog.map(c => c.id)];
    if (!ids.length || ids.length > 64) throw new Error('sourceCloudScopeNeedsReview');
    const path: string[] = [n.title]; let parent = n.parentId; const seen = new Set<string>();
    while (parent && !seen.has(parent)) { seen.add(parent); const p = await nativeFolderLookup(parent); if (!p) break; path.unshift(p.title); parent = p.parentId; }
    roots.push({ ruleId: item.id, nodeId: mapping.colpId, resourceRevision: mapping.projection.resourceRevision ?? mapping.projection.revision, collectionIds: ids });
    nativeRoots.push({ ruleId: item.id, nativeId: id, dateAdded: n.dateAdded, path: path.join(' / ') });
  }
  if (!roots.length) throw new Error('chooseSyncedSourceRuleRoot');
  const scope: CloudScope = { site: definition.siteKey, identityVersion: definition.identityVersion, sourceAccount: authority.accountId, collectionId: owner.collectionId, roots,
    policy: { revision: policy.policy.revision, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' },
    rulesDigest: sourceDigest(flat), bindingDigest: sourceDigest({ owner, nativeRoots }) };
  return { owner, authority, scope, nativeRoots, fence: sourceDigest({ owner, authority, scope, nativeRoots }) };
}
async function state() { const s = await snapshot(); return { snapshot: s, record: await db.read<RecordState>('meta', stateKey(s.authority.connectionId!)) }; }
async function requireRecord() {
  const s = await state(); if (!s.record || s.record.revoked || s.record.snapshot.fence !== s.snapshot.fence) throw new Error('sourceCloudApprovalRequired'); return { ...s, record: s.record };
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function validCloudManagement(v: unknown): boolean {
  if (!record(v) || typeof v.kind !== 'string' || !v.kind.startsWith('known.siteAdapters.cloud.')) return false;
  const op = v.kind.slice('known.siteAdapters.cloud.'.length);
  return ['status', 'review', 'preview', 'recover', 'revoke', 'cancel'].includes(op) ? Object.keys(v).length === 1
    : ['approve', 'commit'].includes(op) ? Object.keys(v).length === 2 && typeof v.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(v.digest)
    : op === 'configureRule' && Object.keys(v).length === 3 && typeof v.rootNativeId === 'string' && v.rootNativeId.length < 129 && Array.isArray(v.collectionIds)
      && v.collectionIds.length > 0 && v.collectionIds.length <= 64 && new Set(v.collectionIds).size === v.collectionIds.length && v.collectionIds.every(x => definition.validateCollection(x));
}
async function handleCloudManagement(raw: unknown) {
  if (!validCloudManagement(raw)) throw new Error('invalid'); const r = raw as { kind: string; digest?: string; rootNativeId?: string; collectionIds?: string[] };
  return lane(async () => {
    const { api, owner } = await client();
    if (r.kind.endsWith('.status')) {
      const server = await api.call<unknown>('status', {}); let local: unknown = null;
      try { const s = await state(); const pending = s.record?.pending ? await db.read<Plan>('meta', planKey(s.record.pending)) : undefined;
        local = { approved: !!s.record && !s.record.revoked && s.record.snapshot.fence === s.snapshot.fence, pending: pending ? { planId: pending.planId, digest: pending.digest, state: pending.state, receipt: pending.receipt ?? null } : null }; } catch (e) { local = { reason: e instanceof Error ? e.message : 'sourceCloudUnavailable' }; }
      return { server, local };
    }
    if (r.kind.endsWith('.configureRule')) {
      await api.profile();
      const a = await db.read<SourceAuthority>('authorities', definition.adapterId); if (!a?.enabled || !a.connectionId) throw new Error('sourceAuthorizationChanged');
      await assertSourceRebound(db, a.connectionId);
      const m = await syncState.getMappingByNativeId(owner, r.rootNativeId!); const n = (await chrome.bookmarks.get(r.rootNativeId!).catch(() => []))[0];
      if (!m || m.quarantine || m.nodeKind !== 'folder' || !n || n.url || !n.dateAdded) throw new Error('sourceCloudMappingNeedsReview');
      const target = await captureTarget(await currentCaptureScope(), n.id);
      if (!target.inRange || target.collectionId !== owner.collectionId) throw new Error('sourceCloudMappingNeedsReview');
      const catalog = await db.transaction(['collections'], 'readonly', tx => rows<{ entity: SiteCollection }>(tx, 'collections', a.connectionId));
      if (r.collectionIds!.some(id => !catalog.some(c => c.entity.id === id && c.entity.identity === 'siteId'))) throw new Error('refreshCatalogRequired');
      const policy = await db.read<SourcePolicyRecord>('meta', `policy:${a.connectionId}`);
      if (policy && policy.policy.copies !== 'sourceAndSemantic') throw new Error('sourceCloudCopyPolicyNeedsReview');
      const key = `sourceCloudRule:${a.connectionId}`, old = await db.read<string>('meta', key);
      const priorMount = old ? await db.read<SourceMount>('mounts', sourceKey(a.connectionId, old)) : undefined;
      if (priorMount && (priorMount.root.nativeId !== n.id || priorMount.root.dateAdded !== n.dateAdded)) throw new Error('mountMigrationRequired');
      return withDestinationPolicyBoundary(async () => { await assertNoCloudDestinationWork();
      const saved = await browserRuleStore().saveRule({ ...(old ? { id: old } : {}), draft: { name: `${definition.label} COLP archive`, combinator: 'all', conditions: [{ kind: 'siteIs', value: new URL(definition.origin).hostname }],
        action: { kind: 'file', folderNativeId: n.id }, site: { version: 1, admission: { entries: ['siteImport', 'reconcile'], purpose: 'sourceArchive', connectionId: a.connectionId!, collectionIds: r.collectionIds! }, layout: { kind: 'sourceCollections', root: 'actionDestination' } } } }, Date.now());
      if (!saved.ok) throw new Error('ruleRejected');
        const mount: SourceMount = { id: sourceDigest([a.connectionId, saved.rule.id]), connectionId: a.connectionId!, rootRuleId: saved.rule.id, revision: 1, state: 'active', aiDestination: 'excluded',
          root: { bindingId: crypto.randomUUID(), kind: 'folder', nativeId: n.id, dateAdded: n.dateAdded!, deviceId: await captureDeviceId(), proof: { kind: 'explicitAdoption', id: saved.rule.id } } };
        await db.transaction(['meta', 'mounts'], 'readwrite', async tx => { const previous = await get<SourceMount>(tx, 'mounts', sourceKey(a.connectionId, saved.rule.id));
          if (previous && (previous.root.nativeId !== n.id || previous.root.dateAdded !== n.dateAdded)) throw new Error('mountMigrationRequired');
          put(tx, 'meta', key, saved.rule.id); put(tx, 'mounts', sourceKey(a.connectionId, saved.rule.id), previous ?? mount);
          if (!policy) put(tx, 'meta', `policy:${a.connectionId}`, { connectionId: a.connectionId, enabled: true, liveArchive: false, policy: { revision: 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } }); });
      return { configured: true }; });
    }
    if (r.kind.endsWith('.review')) {
      const s = await snapshot(), server = await api.call<{ connections: { site?: string; identityVersion?: number; sourceAccount: string; epoch: number; lease: { replicaId: string; expiresAt: number } | null }[] }>('status', {});
      const c = server.connections.find(c => c.sourceAccount === s.scope.sourceAccount && (c.site ?? legacySite.siteKey) === s.scope.site && (c.identityVersion ?? legacySite.identityVersion) === s.scope.identityVersion), expectedEpoch = c?.epoch ?? 0;
      const review = { snapshot: s, expectedEpoch, digest: sourceDigest({ scope: s.scope, replicaId: owner.replicaId, expectedEpoch }) };
      await db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', 'sourceCloudReview', { ...review, expiresAt: Date.now() + 600000 }));
      return { digest: review.digest, sourceAccount: s.scope.sourceAccount, roots: s.nativeRoots, scope: s.scope, currentAuthority: c?.lease ?? null, expectedEpoch };
    }
    if (r.kind.endsWith('.approve')) {
      const review = await db.read<{ snapshot: Snapshot; expectedEpoch: number; digest: string; expiresAt: number }>('meta', 'sourceCloudReview');
      const s = await snapshot(); if (!review || review.expiresAt <= Date.now() || review.digest !== r.digest || review.snapshot.fence !== s.fence) throw new Error('sourceCloudPreviewStale');
      const existing = await db.read<RecordState>('meta', stateKey(s.authority.connectionId!));
      if (existing?.pending && (await db.read<Plan>('meta', planKey(existing.pending)))?.state !== 'committed') throw new Error('sourceCloudRecoverFirst');
      const granted = await api.call<{ lease: CloudLease; scopeDigest: string }>('configure', { scope: s.scope, replicaId: owner.replicaId, expectedEpoch: review.expectedEpoch, approvalDigest: r.digest });
      if (granted.scopeDigest !== sourceDigest(s.scope) || granted.lease.replicaId !== owner.replicaId || granted.lease.epoch !== review.expectedEpoch + 1) throw new Error('sourceCloudInvalid');
      await db.transaction(['meta'], 'readwrite', async tx => { const old = await get<RecordState>(tx, 'meta', stateKey(s.authority.connectionId!));
        if (old?.pending) { const p = await get<Plan>(tx, 'meta', planKey(old.pending)); if (p && p.state !== 'committed') throw new Error('sourceCloudRecoverFirst'); }
        put(tx, 'meta', activeKey(owner), s.authority.connectionId);
        put(tx, 'meta', stateKey(s.authority.connectionId!), { snapshot: s, lease: granted.lease, scopeDigest: granted.scopeDigest, after: old?.snapshot.fence === s.fence ? old.after : null, processed: old?.snapshot.fence === s.fence ? old.processed : {}, pending: null } satisfies RecordState); });
      return { approved: true, epoch: granted.lease.epoch };
    }
    if (r.kind.endsWith('.recover') || r.kind.endsWith('.revoke') || r.kind.endsWith('.cancel')) {
      const id = await db.read<string>('meta', activeKey(owner)), c = id ? await db.read<RecordState>('meta', stateKey(id)) : undefined;
      if (!id || !c || !sameOwner(c.snapshot.owner, owner)) throw new Error('sourceCloudPlanMissing');
      if (r.kind.endsWith('.revoke')) {
        await db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', stateKey(id), { ...c, revoked: true }));
        return api.call('revoke', { sourceAccount: c.snapshot.scope.sourceAccount, expectedEpoch: c.lease.epoch });
      }
      const p = c.pending ? await db.read<Plan>('meta', planKey(c.pending)) : undefined;
      if (!p) throw new Error('sourceCloudPlanMissing');
      if (r.kind.endsWith('.cancel')) {
        if (p.state === 'submitted' || p.state === 'unknown') throw new Error('sourceCloudRecoverFirst');
        const cancelled = await api.call<{ state: string; receipt: unknown }>('cancel', { planId: p.planId, digest: p.digest });
        if (cancelled.receipt) { assertCloudReceipt(cancelled.receipt, p); p.receipt = cancelled.receipt; p.state = 'committed'; }
        else if (cancelled.state === 'cancelled') p.state = 'cancelled'; else throw new Error('sourceCloudInvalid');
        await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', planKey(p.planId), p); put(tx, 'meta', stateKey(id), { ...c, pending: p.state === 'cancelled' ? null : c.pending, after: p.state === 'committed' ? p.after : c.after, processed: p.state === 'committed' ? cloudProgress(c.processed, p.ordinals ?? {}) : c.processed }); });
        return { state: p.state, receipt: p.receipt ?? null };
      }
      let recovered: { state: string; receipt: unknown };
      try { recovered = await api.call('recover', { planId: p.planId, digest: p.digest }); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'source_plan_missing' || p.state !== 'prepared' || (await requireRecord()).snapshot.fence !== p.snapshotFence) throw error;
        const prepared = await api.call<{ digest: string }>('preview', { sourceAccount: p.scope.sourceAccount, lease: c.lease, planId: p.planId, edges: p.edges, scopeDigest: c.scopeDigest });
        if (prepared.digest !== p.digest) throw new Error('sourceCloudInvalid'); recovered = { state: 'prepared', receipt: null };
      }
      if (recovered.receipt) { assertCloudReceipt(recovered.receipt, p); p.receipt = recovered.receipt; p.state = 'committed'; }
      else if (recovered.state === 'prepared') p.state = 'prepared'; else if (recovered.state === 'cancelled') p.state = 'cancelled'; else throw new Error('sourceCloudInvalid');
      await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', planKey(p.planId), p); if (p.state === 'committed') put(tx, 'meta', stateKey(id), { ...c, after: p.after, processed: cloudProgress(c.processed, p.ordinals ?? {}) }); });
      return { state: p.state, digest: p.digest, edges: p.edges, receipt: p.receipt ?? null };
    }
    const { snapshot: s, record: c } = await requireRecord();
    if (r.kind.endsWith('.preview')) {
      if (c.pending) { const p = await db.read<Plan>('meta', planKey(c.pending)); if (p && p.state !== 'committed') throw new Error('sourceCloudRecoverFirst'); }
      const renewed = await api.call<{ lease: CloudLease }>('renew', { sourceAccount: s.scope.sourceAccount, lease: c.lease }); c.lease = renewed.lease;
      const flat = await currentFlat(), entries = await db.transaction(['memberships'], 'readonly', tx => rows<LedgerEdge>(tx, 'memberships', s.authority.connectionId));
      if (entries.length > 50000) throw new Error('sourceCloudCapacity');
      const edges: CloudEdge[] = [], ordinals: Record<string, number> = {}; let after = c.after; let omissions = 0, remaining = false;
      for (const e of entries.sort((a, b) => sourceKey(a.connectionId, a.itemId, a.collectionId) < sourceKey(b.connectionId, b.itemId, b.collectionId) ? -1 : 1)) {
        const edgeKey = sourceKey(e.connectionId, e.itemId, e.collectionId); if (!cloudEdgeUnseen(c.processed, edgeKey, e.ordinal) || e.connectionId !== s.authority.connectionId || e.state !== 'present') continue;
        if (edges.length === 20) { remaining = true; break; } after = edgeKey;
        await assertRestoredItemAvailable(db, e.connectionId, e.itemId, e.collectionId);
        const item = (await db.read<{ entity: SiteItem }>('items', sourceKey(e.connectionId, e.itemId)))?.entity;
        const col = (await db.read<{ entity: SiteCollection }>('collections', sourceKey(e.connectionId, e.collectionId)))?.entity;
        if (!item || !col || col.identity !== 'siteId' || e.conflicts.length || !definition.validateItem(item)) { omissions++; continue; }
        const result = await decideList(flat.items, { url: item.url, title: item.title, explicit: false }, nativeFolderLookup, Date.now(), { site: { entry: 'siteImport', purpose: 'sourceArchive', connectionId: e.connectionId, collectionId: e.collectionId } });
        const d = result.decision; if (!d || d.outcome !== 'placed' || !s.scope.roots.some(root => root.ruleId === d.item.id && root.collectionIds.includes(e.collectionId))) { omissions++; continue; }
        // Page/community code cannot grant an account/cloud archive authority.
        const obs = await db.read<{ context?: { communityOrigin?: unknown } }>('observations', e.observationId);
        if (obs?.context?.communityOrigin) { omissions++; continue; }
        ordinals[edgeKey] = e.ordinal;
        edges.push({ itemId: item.id, collectionId: col.id, collectionTitle: col.title, title: item.title, url: item.url, ruleId: d.item.id, entry: 'siteImport', observationDigest: sourceDigest({ edge: e, item, col }) });
      }
      if (!edges.length) return { state: 'empty', omissions, remaining, reason: 'No admitted unseen edges. Earlier source rules keep their priority.' };
      if ((await snapshot()).fence !== s.fence) throw new Error('sourceCloudPreviewStale');
      const planId = crypto.randomUUID(), expectedDigest = sourceDigest({ planId, sourceAccount: s.scope.sourceAccount, scope: s.scope, epoch: c.lease.epoch, edges });
      const p: Plan = { planId, digest: expectedDigest, epoch: c.lease.epoch, scope: s.scope, edges, owner, snapshotFence: s.fence, after, ordinals, state: 'prepared' };
      // Intent survives a lost prepare response; retry/recovery always names this plan.
      await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', planKey(planId), p); put(tx, 'meta', stateKey(s.authority.connectionId!), { ...c, pending: planId }); });
      const prepared = await api.call<{ digest: string }>('preview', { sourceAccount: s.scope.sourceAccount, lease: c.lease, planId, edges, scopeDigest: c.scopeDigest });
      if (prepared.digest !== expectedDigest) throw new Error('sourceCloudInvalid'); return { planId, digest: expectedDigest, edges, omissions, remaining, nativeRoots: s.nativeRoots };
    }
    if (!c.pending) throw new Error('sourceCloudPlanMissing'); const p = await db.read<Plan>('meta', planKey(c.pending)); if (!p || !sameOwner(p.owner, owner)) throw new Error('sourceCloudOwnerChanged');
      if (r.digest !== p.digest || p.snapshotFence !== s.fence || !['prepared', 'committed'].includes(p.state)) throw new Error('sourceCloudRecoverFirst');
      // Source facts and ordinal changes require a fresh preview, even when its rules stayed put.
      for (const e of p.edges) { const live = await db.read<LedgerEdge>('memberships', sourceKey(s.authority.connectionId, e.itemId, e.collectionId)); const item = (await db.read<{ entity: SiteItem }>('items', sourceKey(s.authority.connectionId, e.itemId)))?.entity; const col = (await db.read<{ entity: SiteCollection }>('collections', sourceKey(s.authority.connectionId, e.collectionId)))?.entity; if (!live || !item || !col || sourceDigest({ edge: live, item, col }) !== e.observationDigest) throw new Error('sourceCloudFactsChanged'); }
      const renewed = await api.call<{ lease: CloudLease }>('renew', { sourceAccount: s.scope.sourceAccount, lease: c.lease }); c.lease = renewed.lease;
      p.state = 'submitted'; await db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', planKey(p.planId), p));
      try { const result = await api.call<unknown>('commit', { sourceAccount: s.scope.sourceAccount, lease: c.lease, planId: p.planId, digest: p.digest }); assertCloudReceipt(result, p); p.receipt = result; p.state = 'committed'; }
      catch (e) { p.state = 'unknown'; await db.transaction(['meta'], 'readwrite', async tx => put(tx, 'meta', planKey(p.planId), p)); throw e; }
    await db.transaction(['meta'], 'readwrite', async tx => { put(tx, 'meta', planKey(p.planId), p); put(tx, 'meta', stateKey(s.authority.connectionId!), { ...c, after: p.after, processed: cloudProgress(c.processed, p.ordinals ?? {}) }); });
    return { state: p.state, receipt: p.receipt };
  });
}

return { validCloudManagement, handleCloudManagement };
}
export const { validCloudManagement, handleCloudManagement } = createCloudRuntime();
