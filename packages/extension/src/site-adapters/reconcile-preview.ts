import { reconcileSnapshot, type ReconcilePage } from './reconcile-scan.js';
import { reconcileDifferences } from './reconcile-diff.js';
import type { ReconcilePreview } from './reconcile-model.js';
import type { ReconcileInventory } from './reconcile-inventory.js';
import type { ImportJob, Edge } from './import-coordinator.js';
import type { SiteDefinition } from './registry-types.js';
import type { LedgerEdge } from './ledger-types.js';
import { sourceKey, sourceDigest, type SourceDatabase } from './source-db.js';
export const reconcileKey = (id: string) => `reconcilePreview:${id}`;
export function createReconcilePreview(db: SourceDatabase, definition: SiteDefinition, inventory: (job: ImportJob) => Promise<ReconcileInventory>) {
  const cached = (job: ImportJob) => `reconcileInventory:${job.previewId}`;
  let current: { id: string; candidates: Set<string>; positives: Set<string> } | undefined;
  async function build(job: ImportJob, data: ReconcileInventory) {
    const pages: ReconcilePage[] = [];
    for (const receipt of job.pageReceipts) {
      const row = await db.read<ReconcilePage>('importPages', receipt.id);
      // Page receipts use a receipt ID distinct from the request's persistent page key.
      if (row) pages.push(row);
    }
    if (!pages.length) await db.transaction(['importPages'], 'readonly', tx => new Promise<void>((resolve, reject) => {
      const request = tx.objectStore('importPages').openCursor(); request.onerror = () => reject(request.error); request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return resolve();
        const row = cursor.value as ReconcilePage & { receipt?: { id: string } };
        if (row.request?.runId === job.id && row.receipt && job.pageReceipts.some(r => r.id === row.receipt!.id)) pages.push(row);
        cursor.continue();
      };
    }));
    pages.sort((a, b) => job.pageReceipts.findIndex(r => r.id === (a as ReconcilePage & { receipt: { id: string } }).receipt?.id)
      - job.pageReceipts.findIndex(r => r.id === (b as ReconcilePage & { receipt: { id: string } }).receipt?.id));
    const restart = pages.findLastIndex(p => p.request.query.kind === 'collections' && p.request.query.cursor === null);
    if (restart > 0) pages.splice(0, restart);
    const snapshots = job.selected.map(id => reconcileSnapshot(definition, id, pages));
    const differences = [] as ReconcilePreview['differences'][number][];
    const run = await db.read<{ baselineOrdinal: number }>('importRuns', job.id);
    for (const snapshot of snapshots) {
      const folder = data.folders.find(f => f.collectionId === snapshot.collectionId);
      const reps = data.representations.filter(r => r.sourceCollectionId === snapshot.collectionId);
      const negatives = new Set<string>();
      for (const rep of reps) {
        const edge = await db.read<LedgerEdge>('memberships', sourceKey(job.context.connectionId, rep.itemId, snapshot.collectionId));
        if (edge && edge.liveOrdinal > (run?.baselineOrdinal ?? 0)) { snapshot.absence = 'unverified'; snapshot.reason = 'sourceFactsChanged'; }
        if (edge?.state === 'absent' && edge.evidence !== 'import' && edge.ordinal > (run?.baselineOrdinal ?? 0)) negatives.add(rep.itemId);
      }
      differences.push(...reconcileDifferences({ snapshot, representations: reps, nodes: data.nodes.map(n => ({ ...n, protected: n.protected || data.representations.some(r => r.native.nativeId === n.native.nativeId && r.sourceCollectionId !== snapshot.collectionId) })), collectionParentId: folder?.native?.nativeId ?? '',
        negative: id => negatives.has(id), candidates: (item, node) => {
          const identity = node.url && definition.contentIdentity(node.url);
          return node.parentId === folder?.native?.nativeId && !!identity && identity.siteKey === definition.siteKey && identity.identityVersion === definition.identityVersion && identity.itemId === item.id;
        } }));
    }
    return differences.length > 10000 ? Promise.reject(new Error('capacity')) : { snapshots, differences };
  }
  return {
    async begin(job: ImportJob) {
      if (current?.id === job.previewId) return;
      let record = await db.read<{ differences: ReconcilePreview['differences'] }>('meta', cached(job));
      if (!record) {
        const result = await build(job, await inventory(job)); record = result;
        await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(result, cached(job)); });
      }
      current = { id: job.previewId!, positives: new Set(record.differences.filter(d => d.source).map(d => sourceKey(d.collectionId, d.itemId))), candidates: new Set(record.differences.filter(d => d.kind === 'candidate').map(d => sourceKey(d.collectionId, d.itemId))) };
    },
    async inspect(job: ImportJob, edge: Edge) {
      await this.begin(job); return !current!.positives.has(sourceKey(edge.collectionId, edge.itemId)) || current!.candidates.has(sourceKey(edge.collectionId, edge.itemId));
    },
    async freeze(job: ImportJob) {
      const record = await db.read<{ snapshots: ReconcilePreview['snapshots']; differences: ReconcilePreview['differences'] }>('meta', cached(job));
      if (!record) throw new Error('reconcileInventoryMissing');
      const preview: ReconcilePreview = { version: 1, id: job.previewId!, importId: job.id, context: job.context, digest: '', createdAt: Date.now(),
        snapshots: record.snapshots, differences: record.differences };
      preview.digest = sourceDigest(preview);
      await db.transaction(['meta'], 'readwrite', async tx => { tx.objectStore('meta').put(preview, reconcileKey(job.id)); });
    },
  };
}
