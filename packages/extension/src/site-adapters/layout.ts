import { decideList } from '../automation/rule-list-decide.js';
import type { FlatList } from '../automation/rule-list-flatten.js';
import type { SiteRuleEdge } from '../automation/site-rule.js';
import type { BrowserRuleSnapshot, MountBinding, NativeBinding, SaveEffect, SavePlan, SavePolicy, SiteCollection, SiteItem, SourceFolderReservation, Representation } from './contracts.js';
import type { SourceContext, LedgerEdge } from './ledger-types.js';
import { get, put, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
import { createSourceReservations, representationKey } from './reservations.js';
import { effectDigest, persistSavePlan } from './planned-executor.js';
import { cursorPage } from '../sync-state/idb.js';

export interface SourcePolicyRecord { connectionId: string; enabled: boolean; liveArchive: boolean; policy: SavePolicy }
export interface SourceMount extends MountBinding { state: 'active' | 'detached' | 'suppressed' }
export interface LayoutNativeNode { id: string; title: string; parentId?: string; url?: string; dateAdded?: number }
export interface LayoutPorts {
  rules(): Promise<FlatList>;
  paused(): Promise<boolean>;
  deviceId(): Promise<string>;
  lookup(id: string): Promise<LayoutNativeNode | null>;
  assertRoot(binding: NativeBinding<'folder'>): Promise<void>;
}
interface PlanFence { edge: LedgerEdge; item: SiteItem; collection: SiteCollection; ruleDigest: string; entry: SiteRuleEdge['entry'] }
const snapshot = (f: FlatList): BrowserRuleSnapshot => ({ storageVersion: 3, listRevision: f.revision, contentVersions: f.contentVersions });
const keyForMount = (connection: string, rule: string) => sourceKey(connection, rule);
const identity = (value: unknown) => sourceDigest(value).slice(7);

/** Host-only layout planner. A scan may reserve drafts, but only separate approval can execute them. */
export function createSourceLayout(db: SourceDatabase, ports: LayoutPorts) {
  const reservations = createSourceReservations(db);
  async function policy(connectionId: string) {
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
    return db.transaction(['mounts'], 'readwrite', async tx => {
      const existing = await get<SourceMount>(tx, 'mounts', key);
      if (existing) { if (existing.root.nativeId !== rootId || existing.root.dateAdded !== root.dateAdded) throw new Error('mountMigrationRequired'); return existing; }
      put(tx, 'mounts', key, value); return value;
    });
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
      if (input.entry !== 'siteImport' && !settings.liveArchive) throw new Error('liveArchiveDisabled');
      // The remaining policies are enabled only after semantic bindings are installed in SA-07.
      if (settings.policy.copies !== 'sourceAndSemantic') throw new Error('copyPolicyNeedsReview');
      const facts = await current(c.connectionId, input.itemId, input.collectionId);
      if (facts.edge?.state !== 'present' || !facts.item || !facts.collection || facts.collection.identity !== 'siteId') throw new Error('sourceFactsUnresolved');
      if (facts.collection.parentId !== null) throw new Error('sourceAncestryNeedsReview');
      const edge: SiteRuleEdge = { entry: input.entry, purpose: 'sourceArchive', connectionId: c.connectionId, collectionId: input.collectionId };
      const { flat, decision } = await evaluate(edge, facts.item);
      if (!decision) return { status: 'noMatch', snapshot: snapshot(flat) } as const;
      if (decision.outcome !== 'placed' || !decision.folder) throw new Error(decision.reason ?? 'bindingUnavailable');
      const m = await mount(c.connectionId, decision.item.id, decision.folder.nativeId);
      const representation = { connectionId: c.connectionId, itemId: input.itemId, purpose: 'sourceArchive' as const, sourceCollectionId: input.collectionId, mountId: m.id };
      const existing = await db.read<Representation>('representations', representationKey(representation));
      if (existing) {
        const node = await ports.lookup(existing.native.nativeId);
        if (existing.state === 'active' && (!node || node.dateAdded !== existing.native.dateAdded
          || existing.lastWritten && (node.title !== existing.lastWritten.title || node.parentId !== existing.lastWritten.parentId))) {
          await reservations.manualChange(representation, node && node.dateAdded === existing.native.dateAdded ? 'detached' : 'suppressed');
          return { status: 'suppressed', representation: await db.read<Representation>('representations', representationKey(representation)) } as const;
        }
        return { status: existing.state === 'active' ? 'represented' : 'suppressed', representation: existing } as const;
      }
      const id = identity({ trigger: input.trigger, representation, snapshot: snapshot(flat), policy: settings.policy.revision });
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
      const bookmark: SaveEffect = { kind: 'createBookmark', effectId: 'bookmark', commandId: identity({ id, effect: 'bookmark' }), payloadDigest: '',
        dependsOn: ['folder'], representation, item: facts.item, parent: { kind: 'sourceFolder', reservationId: folder.id }, folderReservationDigest: folder.payloadDigest };
      ensure.payloadDigest = effectDigest(ensure); bookmark.payloadDigest = effectDigest(bookmark);
      const { payloadDigest: _digest, ...payload } = bookmark;
      await reservations.reserveItem(representation, payload, settings.policy.copies, bookmark.commandId);
      const plan: SavePlan = { id, trigger: input.trigger, purpose: 'sourceArchive', connectionId: c.connectionId, installationGeneration: c.installationGeneration,
        collectorGeneration: c.installationGeneration, sourceSessionGeneration: c.sourceSessionGeneration, importApprovalId: null,
        browserRules: snapshot(flat), rule: { source: 'browser', entry: decision.item.ref.kind === 'setRule' ? { kind: 'setRule', setId: decision.item.ref.setId!, ruleId: decision.item.id } : { kind: 'rule', ruleId: decision.item.id }, definitionDigest: sourceDigest({ definition: decision.item.definition, site: decision.item.site }) },
        mount: { id: m.id, revision: m.revision }, policyRevision: settings.policy.revision, classificationPolicyDigest: 'disabled', classification: 'disabled', effects: [ensure, bookmark] };
      const fence: PlanFence = { edge: facts.edge, item: facts.item, collection: facts.collection, entry: input.entry, ruleDigest: plan.rule!.source === 'browser' ? plan.rule!.definitionDigest : '' };
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
      const now = await current(plan.connectionId, fence.item.id, fence.collection.id);
      if (sourceDigest(now) !== sourceDigest({ edge: fence.edge, item: fence.item, collection: fence.collection })) throw new Error('sourceFactsChanged');
      const { flat, decision } = await evaluate({ entry: fence.entry, purpose: 'sourceArchive', connectionId: plan.connectionId, collectionId: fence.collection.id }, fence.item);
      if (sourceDigest(snapshot(flat)) !== sourceDigest(plan.browserRules) || decision?.outcome !== 'placed' || !decision.folder
        || sourceDigest({ definition: decision.item.definition, site: decision.item.site }) !== fence.ruleDigest) throw new Error('rulesChanged');
      const m = await db.read<SourceMount>('mounts', keyForMount(plan.connectionId, decision.item.id));
      if (!m || m.id !== plan.mount.id || m.revision !== plan.mount.revision) throw new Error('mountChanged');
      await checkMount(m, decision.folder.nativeId);
      const folder = await db.read<SourceFolderReservation>('folderReservations', sourceKey(m.id, fence.collection.id));
      if (!folder || folder.payloadDigest !== effect.folderReservationDigest) throw new Error('folderChanged');
      await assertFolder(folder);
    },
    /** Browser events retain historical associations. Deletions suppress; edits detach. */
    async nativeChanged(nativeIds: readonly string[], deleted: boolean) {
      const ids = new Set(nativeIds);
      await db.transaction(['representations', 'folderReservations', 'mounts'], 'readwrite', async tx => {
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
