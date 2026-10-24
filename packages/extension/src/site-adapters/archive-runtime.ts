import { array, integer, jsonBytes, literal, object, str } from './schema.js';
import { BILIBILI } from './bilibili/identity.js';
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
import { assertPlannedNative } from '../sw/planned-capture.js';
import type { SourcePolicyRecord } from './layout.js';
import { createLane } from '../automation/lane.js';
import { sourceAutomationsPaused } from '../sw/automation.js';
const configureSchema = object({ kind: literal('known.siteAdapters.archive.configure'), rootNativeId: str(128),
  collectionIds: array(v => typeof v === 'string' && /^[1-9]\d{0,19}$/u.test(v), 64, 1, v => v), live: literal(true, false) });
const disableSchema = object({ kind: literal('known.siteAdapters.archive.disable') });
const startSchema = object({ kind: literal('known.siteAdapters.import.start') });
const changeSchema = object({ kind: literal('known.siteAdapters.import.freeze', 'known.siteAdapters.import.resume', 'known.siteAdapters.import.cancel'), jobId: str(128) });
const approveSchema = object({ kind: literal('known.siteAdapters.import.approve'), jobId: str(128), previewId: str(128), revision: integer, digest: str(128) });
interface ArchiveConfig { connectionId: string; ruleId: string; root: NativeBinding<'folder'>; collectionIds: readonly string[]; live: boolean; state: 'pending' | 'active' | 'disabled' }
interface RuntimePorts {
  source(): Promise<{ context: SourceContext; expiresAt: number } | null>;
  readSource(): Promise<{ context: SourceContext; expiresAt: number } | null>;
  catalog(): Promise<readonly SiteCollection[]>;
  send(context: SourceContext, command: HostCommand): void;
  prioritizeLive(): Promise<void>;
  alarm(at: number): void;
}
export function createSourceArchiveRuntime(reads: ReturnType<typeof createReadScheduler>, ports: RuntimePorts) {
  const db = siteLedger.db, configureLane = createLane();
  const configKey = (id: string) => `archiveConfig:${id}`;
  const live = createLiveSourcePlanner(db, sourceLayout, (delay = 100) => ports.alarm(Date.now() + delay));
  const importer = createSiteImporter(siteLedger, sourceLayout, reads, { ...ports, source: ports.readSource, execute: executePlannedSave,
    snapshot: async () => {
      const source = await ports.source();
      // Approved/frozen work can continue without its page. Source authority still fences it.
      const authority = await db.read<import('./ledger-types.js').SourceAuthority>('authorities', 'bundled.bilibili');
      const connectionId = source?.context.connectionId ?? authority?.connectionId;
      if (!connectionId || !authority?.enabled) throw new Error('sourceAuthorizationChanged');
      const flat = await currentFlat(), policy = await db.read<SourcePolicyRecord>('meta', `policy:${connectionId}`);
      if (flat.stopped || await sourceAutomationsPaused() || !policy?.enabled) throw new Error('sourceAutomationPaused');
      return { browserRules: { storageVersion: 3, listRevision: flat.revision, contentVersions: flat.contentVersions }, policyRevision: policy.policy.revision };
    },
  });
  async function config() {
    const a = await db.read<import('./ledger-types.js').SourceAuthority>('authorities', 'bundled.bilibili');
    return a?.connectionId ? db.read<ArchiveConfig>('meta', configKey(a.connectionId)) : undefined;
  }
  return {
    importer, live,
    valid: (v: unknown) => jsonBytes(v, 16384) && [configureSchema, disableSchema, startSchema, changeSchema, approveSchema].some(s => s(v)),
    async status() { return { config: await config() ?? null, import: await importer.status() }; },
    async handle(raw: unknown) {
      if (configureSchema(raw)) return configureLane(async () => {
        const input = raw as { rootNativeId: string; collectionIds: readonly string[]; live: boolean }, source = await ports.source();
        if (!source) throw new Error('pageUnavailable');
        if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) throw new Error('permissionRequired');
        const node = (await chrome.bookmarks.get(input.rootNativeId))[0];
        if (!node || node.url || !node.dateAdded) throw new Error('bindingUnavailable');
        const binding: NativeBinding<'folder'> = { bindingId: crypto.randomUUID(), nativeId: node.id, kind: 'folder', dateAdded: node.dateAdded,
          deviceId: await captureDeviceId(), proof: { kind: 'explicitAdoption', id: crypto.randomUUID() } };
        await assertPlannedNative(binding);
        const catalog = await ports.catalog(), selected = catalog.filter(c => input.collectionIds.includes(c.id));
        if (selected.length !== input.collectionIds.length) throw new Error('refreshCatalogRequired');
        const c = source.context, old = await db.read<ArchiveConfig>('meta', configKey(c.connectionId));
        if (old) await sourceLayout.bindRoot(c.connectionId, old.ruleId, node.id);
        const saved = await browserRuleStore().saveRule({ ...(old ? { id: old.ruleId } : {}), draft: { name: 'Bilibili source archive', combinator: 'all',
          conditions: [{ kind: 'siteIs', value: new URL(BILIBILI.origin).hostname }], action: { kind: 'file', folderNativeId: node.id },
          site: { version: 1, admission: { entries: ['siteImport', 'reconcile'], purpose: 'sourceArchive', connectionId: c.connectionId, collectionIds: input.collectionIds },
            layout: { kind: 'sourceCollections', root: 'actionDestination' } } } }, Date.now());
        if (!saved.ok) throw new Error('ruleRejected');
        let next: ArchiveConfig = { connectionId: c.connectionId, ruleId: saved.rule.id, root: binding, collectionIds: input.collectionIds, live: input.live, state: 'pending' };
        await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(next, configKey(c.connectionId)); });
        const mount = await sourceLayout.bindRoot(c.connectionId, saved.rule.id, node.id);
        for (let offset = 0; offset < selected.length; offset += 32) {
          const receipt = await siteLedger.acceptObservation(c, crypto.randomUUID(), { type: 'catalog.upsert', collections: selected.slice(offset, offset + 32) });
          if (receipt.status === 'rejected') throw new Error(receipt.reason);
        }
        const oldPolicy = await db.read<SourcePolicyRecord>('meta', `policy:${c.connectionId}`);
        await sourceLayout.configure({ connectionId: c.connectionId, enabled: true, liveArchive: input.live,
          admittedAfterOrdinal: old?.live && input.live ? oldPolicy?.admittedAfterOrdinal : await db.read<number>('meta', 'ordinal') ?? 0,
          policy: { revision: (oldPolicy?.policy.revision ?? 0) + 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' } });
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
