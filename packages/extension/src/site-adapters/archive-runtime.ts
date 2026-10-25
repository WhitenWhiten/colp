import { siteFeatures } from './capabilities.js';
import { observedCatalog } from './observed-catalog.js';
import { array, integer, jsonBytes, literal, object, str } from './schema.js';
import { legacySite, type SiteDefinition } from './registry.js';
import type { createSourceLedger } from './ledger.js';
import type { HostCommand, NativeBinding, SiteCollection } from './contracts.js';
import type { SourceContext } from './ledger-types.js';
import { siteLedger } from './source-runtime.js';
import { sourceLayout } from './layout-runtime.js';
import { createSiteImporter } from './import-coordinator.js';
import { createLiveSourcePlanner } from './live-planner.js';
import type { createReadScheduler } from './read-scheduler.js';
import { executePlannedSave } from './planned-runtime.js';
import { currentFlat, browserRuleStore } from '../sw/automation-browser.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
import type { SourcePolicyRecord } from './layout.js';
import { createLane } from '../automation/lane.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
const configureSchemaFor = (definition: SiteDefinition) => object({ kind: literal('known.siteAdapters.archive.configure'), rootNativeId: str(128),
  collectionIds: array(v => definition.validateCollection(v), 64, 1, v => v), live: literal(true, false),
  copies: v => v === undefined || literal('sourceAndSemantic', 'singlePreferSemantic', 'singleKeepExisting')(v),
  primarySourceCollectionId: v => v === undefined || v === null || definition.validateCollection(v),
  semantic: v => v === undefined || literal('manual', 'automatic')(v),
  aiDestination: v => v === undefined || literal('excluded', 'allowed')(v) });
const disableSchema = object({ kind: literal('known.siteAdapters.archive.disable') });
const startSchema = object({ kind: literal('known.siteAdapters.import.start') });
const changeSchema = object({ kind: literal('known.siteAdapters.import.freeze', 'known.siteAdapters.import.resume', 'known.siteAdapters.import.cancel'), jobId: str(128) });
const approveSchema = object({ kind: literal('known.siteAdapters.import.approve'), jobId: str(128), previewId: str(128), revision: integer, digest: str(128) });
interface ArchiveConfig { connectionId: string; ruleId: string; root: NativeBinding<'folder'>; collectionIds: readonly string[]; live: boolean; state: 'pending' | 'active' | 'disabled';
  copies?: import('./contracts.js').SavePolicy['copies']; primarySourceCollectionId?: string | null; aiDestination?: 'excluded' | 'allowed'; semantic?: 'manual' | 'automatic' }
interface RuntimePorts {
  scope?(): Promise<import('../capture/contracts.js').CaptureScope>;
  source(): Promise<{ context: SourceContext; expiresAt: number } | null>;
  readSource(origin?: SourceContext): Promise<{ context: SourceContext; expiresAt: number } | null>;
  catalog(): Promise<readonly SiteCollection[]>;
  send(context: SourceContext, command: HostCommand): void;
  prioritizeLive(): Promise<void>;
  alarm(at: number): void;
}
export function createSourceArchiveRuntime(reads: ReturnType<typeof createReadScheduler>, ports: RuntimePorts, ledger: ReturnType<typeof createSourceLedger> = siteLedger, definition: SiteDefinition = legacySite) {
  const configureSchema = configureSchemaFor(definition), features = siteFeatures(definition);
  const db = ledger.db, configureLane = createLane();
  const configKey = (id: string) => `archiveConfig:${id}`;
  const live = createLiveSourcePlanner(db, sourceLayout, (delay = 100) => ports.alarm(Date.now() + delay), definition);
  const importer = createSiteImporter(ledger, sourceLayout, reads, { ...ports, source: ports.readSource, execute: executePlannedSave,
    snapshot: async () => {
      const source = await ports.source();
      // Approved/frozen work can continue without its page. Source authority still fences it.
      const authority = await db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
      const connectionId = source?.context.connectionId ?? authority?.connectionId;
      if (!connectionId || !authority?.enabled) throw new Error('sourceAuthorizationChanged');
      const flat = await currentFlat(), policy = await db.read<SourcePolicyRecord>('meta', `policy:${connectionId}`);
      if (flat.stopped || await sourceAutomationsPaused() || !policy?.enabled) throw new Error('sourceAutomationPaused');
      return { browserRules: { storageVersion: 3, listRevision: flat.revision, contentVersions: flat.contentVersions }, policyRevision: policy.policy.revision };
    },
  });
  async function config() {
    const a = await db.read<import('./ledger-types.js').SourceAuthority>('authorities', definition.adapterId);
    return a?.connectionId ? db.read<ArchiveConfig>('meta', configKey(a.connectionId)) : undefined;
  }
  return {
    importer, live,
    valid: (v: unknown) => jsonBytes(v, 16384) && [configureSchema, disableSchema, startSchema, changeSchema, approveSchema].some(s => s(v)),
    async status() {
      const source = !features.collections && features.observe ? await ports.source() : null;
      const current = await config(); let hold: string | null = null;
      if (current?.state === 'active') try { await sourceLayout.validateRoot(current.connectionId, current.ruleId, current.root.nativeId); }
      catch (e) { hold = e instanceof Error ? e.message : 'sourceNeedsReview'; }
      return { config: current ?? null, import: await importer.status(), hold,
        ...(!features.collections && features.observe ? { catalog: source ? await observedCatalog(ledger, source.context) : [], catalogCoverage: 'observedOnly' as const } : {}) };
    },
    async handle(raw: unknown) {
      if (configureSchema(raw)) return configureLane(async () => {
        const input = raw as { rootNativeId: string; collectionIds: readonly string[]; live: boolean; copies?: import('./contracts.js').SavePolicy['copies']; primarySourceCollectionId?: string | null; aiDestination?: 'excluded' | 'allowed'; semantic?: 'manual' | 'automatic' }, source = await ports.source();
        if (input.semantic === 'automatic' && input.copies && input.copies !== 'sourceAndSemantic') throw new Error('semanticRequiresTwoCopies');
        if (!features.archive || input.live && !features.liveArchive) throw new Error('unsupported');
        if (!source) throw new Error('pageUnavailable');
        if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) throw new Error('permissionRequired');
        const node = (await chrome.bookmarks.get(input.rootNativeId))[0];
        if (!node || node.url || !node.dateAdded) throw new Error('bindingUnavailable');
        const binding: NativeBinding<'folder'> = { bindingId: crypto.randomUUID(), nativeId: node.id, kind: 'folder', dateAdded: node.dateAdded,
          deviceId: await captureDeviceId(), proof: { kind: 'explicitAdoption', id: crypto.randomUUID() } };
        await assertSourceRoot(binding);
        const catalog = features.collections ? await ports.catalog() : await observedCatalog(ledger, source.context), selected = catalog.filter(c => input.collectionIds.includes(c.id));
        if (selected.length !== input.collectionIds.length) throw new Error('refreshCatalogRequired');
        if (input.primarySourceCollectionId && !input.collectionIds.includes(input.primarySourceCollectionId)) throw new Error('invalidPrimaryCollection');
        const c = source.context, old = await db.read<ArchiveConfig>('meta', configKey(c.connectionId));
        if (old) await sourceLayout.bindRoot(c.connectionId, old.ruleId, node.id, true);
        const saved = await browserRuleStore().saveRule({ ...(old ? { id: old.ruleId } : {}), draft: { name: `${definition.label} source archive`, combinator: 'all',
          conditions: [{ kind: 'siteIs', value: new URL(definition.origin).hostname }], action: { kind: 'file', folderNativeId: node.id },
          site: { version: 1, admission: { entries: ['siteFavorite', 'siteImport', 'reconcile'], purpose: 'sourceArchive', connectionId: c.connectionId, collectionIds: input.collectionIds },
            layout: { kind: 'sourceCollections', root: 'actionDestination' } } } }, Date.now());
        if (!saved.ok) throw new Error('ruleRejected');
        let next: ArchiveConfig = { connectionId: c.connectionId, ruleId: saved.rule.id, root: binding, collectionIds: input.collectionIds, live: input.live, state: 'pending',
          copies: input.copies ?? 'sourceAndSemantic', primarySourceCollectionId: input.primarySourceCollectionId ?? null, aiDestination: input.aiDestination ?? 'excluded', semantic: input.semantic ?? 'manual' };
        await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(next, configKey(c.connectionId)); });
        const mount = await sourceLayout.bindRoot(c.connectionId, saved.rule.id, node.id, true);
        await sourceLayout.configureMount(c.connectionId, saved.rule.id, input.aiDestination ?? 'excluded');
        for (let offset = 0; offset < selected.length; offset += 32) {
          const receipt = await ledger.acceptCatalog(c, crypto.randomUUID(), selected.slice(offset, offset + 32));
          if (receipt.status === 'rejected') throw new Error(receipt.reason);
        }
        const oldPolicy = await db.read<SourcePolicyRecord>('meta', `policy:${c.connectionId}`);
        const owner = await ports.scope?.();
        await sourceLayout.configure({ connectionId: c.connectionId, enabled: true, liveArchive: input.live,
          semantic: input.semantic ?? 'manual', ...(owner ? { semanticOwner: { serverOrigin: owner.serverOrigin, accountId: owner.accountId, collectionId: owner.collectionId } } : {}),
          admittedAfterOrdinal: old?.live && input.live ? oldPolicy?.admittedAfterOrdinal : await db.read<number>('meta', 'ordinal') ?? 0,
          policy: { revision: (oldPolicy?.policy.revision ?? 0) + 1, copies: input.copies ?? 'sourceAndSemantic',
            ...(input.primarySourceCollectionId ? { primarySourceCollectionId: input.primarySourceCollectionId } : {}), backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
        next = { ...next, root: mount.root, state: 'active' };
        await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(next, configKey(c.connectionId)); });
        ports.alarm(Date.now() + 100); return { configured: true };
      });
      if (disableSchema(raw)) return configureLane(async () => {
        const old = await config(); if (!old) return { configured: false };
        const policy = await db.read<SourcePolicyRecord>('meta', `policy:${old.connectionId}`);
        if (policy) await sourceLayout.configure({ ...policy, enabled: false, liveArchive: false, policy: { ...policy.policy, revision: policy.policy.revision + 1 } });
        await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put({ ...old, live: false, state: 'disabled' }, configKey(old.connectionId)); });
        const job = await importer.status(); if (job && !['cancelled', 'completed'].includes(job.phase)) await importer.cancel(job.id);
        return { configured: false };
      });
      if (startSchema(raw)) {
        if (!features.import) throw new Error('unsupported');
        const c = await config(); if (c?.state !== 'active') throw new Error('chooseArchiveRoot');
        return { importId: await importer.start(c.collectionIds) };
      }
      if (changeSchema(raw)) {
        const r = raw as { kind: string; jobId: string };
        if (r.kind.endsWith('.freeze')) await importer.freeze(r.jobId);
        else if (r.kind.endsWith('.resume')) await importer.resume(r.jobId);
        else await importer.cancel(r.jobId); return {};
      }
      if (approveSchema(raw)) return { approvalId: await importer.approve(raw as { jobId: string; previewId: string; revision: number; digest: string }) };
      throw new Error('invalid');
    },
  };
}
