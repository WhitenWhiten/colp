import { admitsSiteEdge } from '../automation/site-rule.js';
import { decideList } from '../automation/rule-list-decide.js';
import type { FlatList } from '../automation/rule-list-flatten.js';
import type { SiteRuleEdge } from '../automation/site-rule.js';
import type { BrowserRuleSnapshot, MountBinding, NativeBinding, SaveEffect, SavePlan, SavePolicy, SiteCollection, SiteItem, SourceFolderReservation, Representation } from './contracts.js';
import type { SourceContext, LedgerEdge } from './ledger-types.js';
import { get, put, rows, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import { createSourceReservations, representationKey } from './reservations.js';
import { effectDigest, persistSavePlan } from './planned-executor.js';
import { cursorPage } from '../sync-state/idb.js';
import { withDestinationPolicyBoundary } from '../classification-destination-boundary.js';
import { assertSourceRebound, assertRestoredItemAvailable } from './portable.js';

export interface SourcePolicyRecord { connectionId: string; enabled: boolean; liveArchive: boolean; admittedAfterOrdinal?: number; policy: SavePolicy }
export interface SourceMount extends MountBinding { state: 'active' | 'detached' | 'suppressed' }
export interface LayoutNativeNode { id: string; title: string; parentId?: string; url?: string; dateAdded?: number }
export interface LayoutPorts {
  authorizeCommunity?(origin: import('./community-state.js').CommunityOrigin, input: { connectionId: string; collectionIds: readonly string[]; rootNativeId: string }): Promise<void>;
  rules(): Promise<FlatList>;
  paused(): Promise<boolean>;
  deviceId(): Promise<string>;
  lookup(id: string): Promise<LayoutNativeNode | null>;
  assertRoot(binding: NativeBinding<'folder'>): Promise<void>;
  beforeExclusion?(): Promise<void>;
  sourceCopies?(input: { connectionId: string; itemId: string; policy: SavePolicy; representation: import('./contracts.js').RepresentationKey }): Promise<
    { status: 'create' | 'dependency' } | { status: 'reuse'; representation: Representation }>;
}
interface PlanFence { edge: LedgerEdge; item: SiteItem; collection: SiteCollection; ruleDigest: string; representation?: import('./contracts.js').RepresentationKey; entry: SiteRuleEdge['entry'] }
const snapshot = (f: FlatList): BrowserRuleSnapshot => ({ storageVersion: 3, listRevision: f.revision, contentVersions: f.contentVersions });
const keyForMount = (connection: string, rule: string) => sourceKey(connection, rule);
const identity = (value: unknown) => sourceDigest(value).slice(7);

/** Host-only layout planner. A scan may reserve drafts, but only separate approval can execute them. */
export function createSourceLayout(db: SourceDatabase, ports: LayoutPorts) {
  const reservations = createSourceReservations(db);
  async function policy(connectionId: string) {
    await assertSourceRebound(db, connectionId);
    const value = await db.read<SourcePolicyRecord>('meta', `policy:${connectionId}`);
    if (!value?.enabled || await ports.paused()) throw new Error('sourceAutomationPaused');
    return value;
  }
  async function current(connectionId: string, itemId: string, collectionId: string) {
    return db.transaction(['memberships', 'items', 'collections'], 'readonly', async tx => ({
      edge: await get<LedgerEdge>(tx, 'memberships', sourceKey(connectionId, itemId, collectionId)),
      item: (await get<{ entity: SiteItem }>(tx, 'items', sourceKey(connectionId, itemId)))?.entity,
      collection: (await get<{ entity: SiteCollection }>(tx, 'collections', sourceKey(connectionId, collectionId)))?.entity,
    }));
  }
  async function checkMount(mount: SourceMount, actionRoot: string) {
    if (mount.state !== 'active' || mount.root.nativeId !== actionRoot) throw new Error('mountMigrationRequired');
    if (mount.root.deviceId !== await ports.deviceId()) throw new Error('bindingNeedsRebind');
    await ports.assertRoot(mount.root);
  }
  async function mount(connectionId: string, ruleId: string, rootId: string) {
    const key = keyForMount(connectionId, ruleId), old = await db.read<SourceMount>('mounts', key);
    if (old) { await checkMount(old, rootId); return old; }
    const node = await ports.lookup(rootId);
    if (!node || node.url || !node.dateAdded) throw new Error('bindingUnavailable');
    const root: NativeBinding<'folder'> = { bindingId: crypto.randomUUID(), nativeId: rootId, kind: 'folder', deviceId: await ports.deviceId(),
      dateAdded: node.dateAdded, proof: { kind: 'explicitAdoption', id: `rule:${ruleId}` } };
    await ports.assertRoot(root);
    const value: SourceMount = { id: identity({ connectionId, ruleId }), connectionId, rootRuleId: ruleId, root, revision: 1, aiDestination: 'excluded', state: 'active' };
    return withDestinationPolicyBoundary(async () => { await ports.beforeExclusion?.(); return db.transaction(['mounts'], 'readwrite', async tx => {
      const existing = await get<SourceMount>(tx, 'mounts', key);
      if (existing) { if (existing.root.nativeId !== rootId || existing.root.dateAdded !== root.dateAdded) throw new Error('mountMigrationRequired'); return existing; }
      put(tx, 'mounts', key, value); return value;
    }); });
  }
  async function assertFolder(folder: SourceFolderReservation) {
    if (folder.state === 'blocked') throw new Error('folderNeedsReview');
    if (!folder.native) return;
    const node = await ports.lookup(folder.native.nativeId);
    // Local edits own the folder; source renames never overwrite its creation receipt.
    if (!node || node.url || node.dateAdded !== folder.native.dateAdded || node.title !== folder.title
      || folder.parent.kind !== 'native' || node.parentId !== folder.parent.binding.nativeId) throw new Error('folderManuallyChanged');
  }
  async function evaluate(edge: SiteRuleEdge, item: SiteItem) {
    const flat = await ports.rules();
    if (flat.stopped) throw new Error('sourceAutomationPaused');
    const result = await decideList(flat.items, { url: item.url, title: item.title, explicit: false }, ports.lookup, Date.now(), { site: edge });
    return { flat, decision: result.decision };
  }
  return {
    /** Explicit configuration adopts an existing local root without creating native objects. */
    bindRoot: mount,
    async configureMount(connectionId: string, ruleId: string, aiDestination: 'excluded' | 'allowed') {
      await withDestinationPolicyBoundary(async () => {
        const old = await db.read<SourceMount>('mounts', keyForMount(connectionId, ruleId));
        if (aiDestination === 'excluded' && old?.aiDestination !== 'excluded') await ports.beforeExclusion?.();
        return db.transaction(['mounts'], 'readwrite', async tx => {
        const key = keyForMount(connectionId, ruleId), m = await get<SourceMount>(tx, 'mounts', key);
        if (!m || m.state !== 'active') throw new Error('bindingNeedsRebind');
        if (m.aiDestination !== aiDestination) put(tx, 'mounts', key, { ...m, aiDestination, revision: m.revision + 1 });
      }); });
    },
    async configure(record: SourcePolicyRecord) {
      if (!Number.isSafeInteger(record.policy.revision) || record.policy.revision < 1 || record.policy.backgroundClassification !== 'disabled'
        || record.policy.sourceRemoval !== 'retainArchive' || !['sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting'].includes(record.policy.copies)) throw new Error('invalidPolicy');
      await db.transaction(['meta'], 'readwrite', async tx => {
        const key = `policy:${record.connectionId}`, old = await get<SourcePolicyRecord>(tx, 'meta', key);
        if (old && record.policy.revision <= old.policy.revision && sourceDigest(record) !== sourceDigest(old)) throw new Error('policyRevisionRequired');
        put(tx, 'meta', key, record);
      });
    },
    async plan(input: { context: SourceContext; itemId: string; collectionId: string; entry: SiteRuleEdge['entry']; trigger: SavePlan['trigger'] }) {
      const { context: c } = input, settings = await policy(c.connectionId);
      await assertRestoredItemAvailable(db, c.connectionId, input.itemId, input.collectionId);
      if (input.trigger.kind === 'observation' && settings.admittedAfterOrdinal !== undefined) {
        const row = await db.read<{ ordinal: number }>('observations', input.trigger.observationId);
        if (!row || row.ordinal <= settings.admittedAfterOrdinal) throw new Error('beforeSourceActivation');
      }
      if (input.entry !== 'siteImport' && !settings.liveArchive) throw new Error('liveArchiveDisabled');
      if (settings.policy.copies !== 'sourceAndSemantic' && !ports.sourceCopies) throw new Error('copyPolicyNeedsReview');
      const facts = await current(c.connectionId, input.itemId, input.collectionId);
      if (facts.edge?.state !== 'present' || !facts.item || !facts.collection || facts.collection.identity !== 'siteId') throw new Error('sourceFactsUnresolved');
      if (facts.collection.parentId !== null) throw new Error('sourceAncestryNeedsReview');
      const edge: SiteRuleEdge = { entry: input.entry, purpose: 'sourceArchive', connectionId: c.connectionId, collectionId: input.collectionId };
      const { flat, decision } = await evaluate(edge, facts.item);
      if (!decision) {
        if (flat.pausedSites?.some(site => admitsSiteEdge(site, edge))) throw new Error('sourceAutomationPaused');
        return { status: 'noMatch', snapshot: snapshot(flat) } as const;
      }
      if (decision.outcome !== 'placed' || !decision.folder) throw new Error(decision.reason ?? 'bindingUnavailable');
      const m = await mount(c.connectionId, decision.item.id, decision.folder.nativeId);
      if (c.communityOrigin) { if (!ports.authorizeCommunity) throw new Error('communityArchiveRevoked');
        await ports.authorizeCommunity(c.communityOrigin, { connectionId: c.connectionId, collectionIds: [input.collectionId], rootNativeId: m.root.nativeId }); }
      const representation = { connectionId: c.connectionId, itemId: input.itemId, purpose: 'sourceArchive' as const, sourceCollectionId: input.collectionId, mountId: m.id };
      const existing = await db.read<Representation>('representations', representationKey(representation));
      if (existing) {
        const node = await ports.lookup(existing.native.nativeId);
        if (settings.policy.copies === 'sourceAndSemantic' && existing.state === 'active') {
          const folder = await db.read<SourceFolderReservation>('folderReservations', sourceKey(m.id, input.collectionId));
          if (folder?.native && node?.parentId !== folder.native.nativeId) throw new Error('copyPolicyMigrationRequired');
        }
        if (existing.state === 'active' && (!node || node.dateAdded !== existing.native.dateAdded || node.url !== (existing.lastWritten?.url ?? facts.item.url)
          || existing.lastWritten && (node.title !== existing.lastWritten.title || node.parentId !== existing.lastWritten.parentId))) {
          await reservations.manualChange(representation, node && node.dateAdded === existing.native.dateAdded ? 'detached' : 'suppressed');
          return { status: 'suppressed', representation: await db.read<Representation>('representations', representationKey(representation)) } as const;
        }
        return { status: existing.state === 'active' ? 'represented' : 'suppressed', representation: existing } as const;
      }
      const copy = await ports.sourceCopies?.({ connectionId: c.connectionId, itemId: input.itemId, policy: settings.policy, representation });
      if (copy?.status === 'dependency') throw new Error('sourceDependencyPending');
      if (copy?.status === 'reuse') return { status: 'represented', representation: copy.representation } as const;
      if (settings.policy.copies !== 'sourceAndSemantic') {
        const memberships = await db.transaction(['memberships'], 'readonly', tx => rows<LedgerEdge>(tx, 'memberships', c.connectionId, input.itemId));
        const eligible: string[] = [];
        for (const membership of memberships) {
          if (membership.state !== 'present') continue;
          const candidate = await decideList(flat.items, { url: facts.item.url, title: facts.item.title, explicit: false }, ports.lookup, Date.now(),
            { site: { ...edge, collectionId: membership.collectionId } });
          if (candidate.decision?.outcome === 'placed') eligible.push(membership.collectionId);
        }
        const primary = settings.policy.primarySourceCollectionId ?? (eligible.length === 1 ? eligible[0] : undefined);
        if (!primary || !eligible.includes(primary)) throw new Error('primarySourceCollectionRequired');
        if (primary !== input.collectionId) return { status: 'policySkipped' } as const;
      }
      const id = identity({ trigger: input.trigger, representation, snapshot: snapshot(flat), policy: settings.policy.revision, ...(c.communityOrigin ? { communityOrigin: c.communityOrigin } : {}) });
      const oldFolder = await db.read<SourceFolderReservation>('folderReservations', sourceKey(m.id, input.collectionId));
      if (oldFolder) {
        await assertFolder(oldFolder);
        if (oldFolder.state !== 'confirmed' && oldFolder.title !== facts.collection.title) throw new Error('folderCreationNeedsReview');
      }
      // Reuse the immutable creation payload after a source rename; names never create identity.
      const folder = await reservations.reserveFolder(oldFolder ? {
        mountId: oldFolder.mountId, collectionId: oldFolder.collectionId, mountRevision: oldFolder.mountRevision, parent: oldFolder.parent, title: oldFolder.title,
      } : { mountId: m.id, collectionId: input.collectionId, mountRevision: m.revision, parent: { kind: 'native', binding: m.root }, title: facts.collection.title }, { planId: id, effectId: 'folder' });
      const ensure: SaveEffect = { kind: 'ensureSourceFolder', effectId: 'folder', commandId: identity({ id, effect: 'folder' }), payloadDigest: '',
        dependsOn: [], reservationId: folder.id, folderReservationDigest: folder.payloadDigest };
      const bookmark: SaveEffect = { kind: 'createBookmark', effectId: 'bookmark', commandId: identity({ representation, effect: 'bookmark' }), payloadDigest: '',
        dependsOn: ['folder'], representation, item: facts.item, parent: { kind: 'sourceFolder', reservationId: folder.id }, folderReservationDigest: folder.payloadDigest };
      ensure.payloadDigest = effectDigest(ensure); bookmark.payloadDigest = effectDigest(bookmark);
      const { payloadDigest: _digest, ...payload } = bookmark;
      const itemReservation = await reservations.reserveItem(representation, payload, settings.policy.copies, bookmark.commandId);
      if (itemReservation.status !== 'reserved') throw new Error('sourceDependencyPending');
      const plan: SavePlan = { id, trigger: input.trigger, purpose: 'sourceArchive', connectionId: c.connectionId, installationGeneration: c.installationGeneration,
        ...(c.communityOrigin ? { communityOrigin: c.communityOrigin } : {}),
        collectorGeneration: c.installationGeneration, sourceSessionGeneration: c.sourceSessionGeneration, importApprovalId: null,
        browserRules: snapshot(flat), rule: { source: 'browser', entry: decision.item.ref.kind === 'setRule' ? { kind: 'setRule', setId: decision.item.ref.setId!, ruleId: decision.item.id } : { kind: 'rule', ruleId: decision.item.id }, definitionDigest: sourceDigest({ definition: decision.item.definition, site: decision.item.site }) },
        mount: { id: m.id, revision: m.revision }, policyRevision: settings.policy.revision, classificationPolicyDigest: 'disabled', classification: 'disabled', effects: [ensure, bookmark] };
      const fence: PlanFence = { edge: facts.edge, item: facts.item, collection: facts.collection, representation, entry: input.entry, ruleDigest: plan.rule!.source === 'browser' ? plan.rule!.definitionDigest : '' };
      await db.transaction(['meta'], 'readwrite', async tx => {
        const key = `plan-fence:${id}`, old = await get<PlanFence>(tx, 'meta', key);
        if (old && sourceDigest(old) !== sourceDigest(fence)) throw new Error('sourceFactsChanged');
        put(tx, 'meta', key, fence);
      });
      await persistSavePlan(db, plan, input.entry === 'siteImport' ? 'draft' : 'approved');
      return { status: 'planned', plan } as const;
    },
    async authorize(plan: SavePlan, effect: SaveEffect) {
      const settings = await policy(plan.connectionId);
      if (settings.policy.revision !== plan.policyRevision || plan.classificationPolicyDigest !== 'disabled' || !plan.mount || plan.rule?.source !== 'browser') throw new Error('sourcePolicyChanged');
      const fence = await db.read<PlanFence>('meta', `plan-fence:${plan.id}`);
      if (!fence || fence.entry !== 'siteImport' && !settings.liveArchive) throw new Error('sourceAuthorizationChanged');
      await assertRestoredItemAvailable(db, plan.connectionId, fence.item.id, fence.collection.id);
      if (plan.trigger.kind === 'import' && fence.representation && await db.read('representations', representationKey(fence.representation))) throw new Error('previewStale');
      const now = await current(plan.connectionId, fence.item.id, fence.collection.id);
      if (sourceDigest(now) !== sourceDigest({ edge: fence.edge, item: fence.item, collection: fence.collection })) throw new Error('sourceFactsChanged');
      const { flat, decision } = await evaluate({ entry: fence.entry, purpose: 'sourceArchive', connectionId: plan.connectionId, collectionId: fence.collection.id }, fence.item);
      if (sourceDigest(snapshot(flat)) !== sourceDigest(plan.browserRules) || decision?.outcome !== 'placed' || !decision.folder
        || sourceDigest({ definition: decision.item.definition, site: decision.item.site }) !== fence.ruleDigest) throw new Error('rulesChanged');
      const m = await db.read<SourceMount>('mounts', keyForMount(plan.connectionId, decision.item.id));
      if (!m || m.id !== plan.mount.id || m.revision !== plan.mount.revision) throw new Error('mountChanged');
      if (plan.communityOrigin) { if (!ports.authorizeCommunity) throw new Error('communityArchiveRevoked');
        await ports.authorizeCommunity(plan.communityOrigin, { connectionId: plan.connectionId, collectionIds: [fence.collection.id], rootNativeId: m.root.nativeId }); }
      await checkMount(m, decision.folder.nativeId);
      const folder = await db.read<SourceFolderReservation>('folderReservations', sourceKey(m.id, fence.collection.id));
      if (!folder || folder.payloadDigest !== effect.folderReservationDigest) throw new Error('folderChanged');
      await assertFolder(folder);
    },
    /** Browser events retain historical associations. Deletions suppress; edits detach. */
    async nativeChanged(nativeIds: readonly string[], deleted: boolean) {
      const ids = new Set(nativeIds);
      await db.transaction(['representations', 'folderReservations', 'mounts', 'contentBindings'], 'readwrite', async tx => {
        const bindings = await cursorPage<import('./content-bindings.js').ContentBindingRow>(tx.objectStore('contentBindings'), null, 100001);
        for (const b of bindings) if (b.native && ids.has(b.native.nativeId)) put(tx, 'contentBindings', sourceKey('bilibili', b.content.itemId, b.id), { ...b, state: deleted ? 'suppressed' : 'detached' });
        for (const store of ['representations', 'folderReservations', 'mounts'] as const) {
          const rows = await cursorPage<Representation | SourceFolderReservation | SourceMount>(tx.objectStore(store), null, 100001);
          for (const row of rows) {
            if ('rootRuleId' in row) {
              if (deleted && ids.has(row.root.nativeId)) put(tx, store, keyForMount(row.connectionId, row.rootRuleId), { ...row, state: 'suppressed' });
            } else if ('manualRevision' in row) {
              if (ids.has(row.native.nativeId)) put(tx, store, representationKey(row), { ...row, state: deleted ? 'suppressed' : 'detached', manualRevision: row.manualRevision + 1 });
            } else if (row.native && ids.has(row.native.nativeId)) put(tx, store, sourceKey(row.mountId, row.collectionId), { ...row, state: 'blocked' });
          }
        }
      });
    },
  };
}
