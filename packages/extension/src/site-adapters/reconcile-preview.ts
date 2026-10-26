import { readReconcileData, writeReconcileData, type ReconcileData } from './reconcile-storage.js';
import { reconcileSnapshot, type ReconcilePage } from './reconcile-scan.js';
import { reconcileDifferences } from './reconcile-diff.js';
import type { ReconcilePreview } from './reconcile-model.js';
import type { ReconcileInventory } from './reconcile-inventory.js';
import type { ImportJob, Edge } from './import-coordinator.js';
import type { SiteDefinition } from './registry-types.js';
import type { LedgerEdge } from './ledger-types.js';
import { sourceKey, sourceDigest, type SourceDatabase } from './source-db.js';
import { readSourceConnection } from './content-identity.js';
import type { ReconcileNode } from './reconcile-model.js';
import type { Representation } from './contracts.js';
import { representationKey } from './reservations.js';
export const reconcileKey = (id: string) => `reconcilePreview:${id}`;
export function createReconcilePreview(db: SourceDatabase, definition: SiteDefinition, inventory: (job: ImportJob) => Promise<ReconcileInventory>) {
  const cached = (job: ImportJob) => `reconcileInventory:${job.previewId}`;
  let current: { id: string; candidates: Set<string>; positives: Set<string> } | undefined;
  async function build(job: ImportJob, data: ReconcileInventory) {
    const pages = await db.transaction(['importPages'], 'readonly', async tx => {
      const result: ReconcilePage[] = [];
      for (const receipt of job.pageReceipts) {
        const row = await new Promise<ReconcilePage | undefined>((resolve, reject) => {
          const request = tx.objectStore('importPages').index('receiptId').get(receipt.id);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        if (!row || row.request.runId !== job.id) throw new Error('reconcilePreviewIncomplete');
        result.push(row);
      }
      return result;
    });
    const restart = pages.findLastIndex(p => p.request.query.kind === 'collections' && p.request.query.cursor === null);
    if (restart > 0) pages.splice(0, restart);
    const snapshots = job.selected.map(id => reconcileSnapshot(definition, id, pages));
    const connection = await readSourceConnection(db, job.context.connectionId);
    const identities = new Map(data.nodes.map(node => [node.native.nativeId, node.url ? definition.contentIdentity(node.url) : null]));
    const owners = new Map<string, Set<string>>();
    for (const rep of data.representations) { const set = owners.get(rep.native.nativeId) ?? new Set<string>(); set.add(rep.sourceCollectionId ?? ''); owners.set(rep.native.nativeId, set); }
    const differences = [] as ReconcilePreview['differences'][number][];
    for (const moved of data.movedFolders) differences.push({ id: sourceKey(moved.folder.collectionId, 'folderMoved'), collectionId: moved.folder.collectionId,
      itemId: null, kind: 'folderMoved', title: moved.node.title, native: moved.node.native, expected: moved.node, folder: moved.folder,
      choices: moved.node.protected ? ['keep'] : moved.withinRoot ? ['keep', 'return', 'useLocation'] : ['keep', 'return'] });
    const run = await db.read<{ baselineOrdinal: number }>('importRuns', job.id);
    for (const snapshot of snapshots) {
      const folder = data.folders.find(f => f.collectionId === snapshot.collectionId);
      const reps = data.representations.filter(r => r.sourceCollectionId === snapshot.collectionId);
      const negatives = new Set<string>();
      const candidateIndex = new Map<string, ReconcileNode[]>();
      for (const node of data.nodes) {
        const identity = identities.get(node.native.nativeId);
        if (owners.has(node.native.nativeId) || node.protected || node.parentId !== folder?.native?.nativeId || !identity || identity.siteKey !== definition.siteKey || identity.identityVersion !== definition.identityVersion
          || definition.contentIdScope !== 'site' && identity.accountId !== connection.accountId) continue;
        const list = candidateIndex.get(identity.itemId) ?? []; list.push(node); candidateIndex.set(identity.itemId, list);
      }
      for (const rep of reps) {
        const edge = await db.read<LedgerEdge>('memberships', sourceKey(job.context.connectionId, rep.itemId, snapshot.collectionId));
        if (edge && edge.liveOrdinal > (run?.baselineOrdinal ?? 0)) { snapshot.absence = 'unverified'; snapshot.reason = 'sourceFactsChanged'; }
        if (edge?.state === 'absent' && edge.evidence !== 'import' && edge.ordinal > (run?.baselineOrdinal ?? 0)) negatives.add(rep.itemId);
      }
      differences.push(...reconcileDifferences({ snapshot, representations: reps, nodes: data.nodes.map(n => ({ ...n, protected: n.protected || !!owners.get(n.native.nativeId)
        && !(owners.get(n.native.nativeId)!.size === 1 && owners.get(n.native.nativeId)!.has(snapshot.collectionId)) })), collectionParentId: folder?.native?.nativeId ?? '',
        negative: id => negatives.has(id), candidateNodes: item => candidateIndex.get(item.id) ?? [], candidates: () => true }));
    }
    // Import edges and native inventory have independent bounded admission limits.
    // Persist their union in pages rather than imposing a smaller preview limit.
    return { snapshots, differences };
  }
  return {
    async begin(job: ImportJob) {
      if (current?.id === job.previewId) return;
      let record = await readReconcileData<ReconcileData>(db, cached(job));
      if (!record) {
        const result = await build(job, await inventory(job)); record = result;
        await writeReconcileData(db, cached(job), result);
      }
      current = { id: job.previewId!, positives: new Set(record.differences.filter(d => d.source).map(d => sourceKey(d.collectionId, d.itemId))), candidates: new Set(record.differences.filter(d => d.kind === 'candidate').map(d => sourceKey(d.collectionId, d.itemId))) };
    },
    async inspect(job: ImportJob, edge: Edge) {
      await this.begin(job); return !current!.positives.has(sourceKey(edge.collectionId, edge.itemId)) || current!.candidates.has(sourceKey(edge.collectionId, edge.itemId));
    },
    async freeze(job: ImportJob) {
      const record = await readReconcileData<ReconcileData>(db, cached(job));
      if (!record) throw new Error('reconcileInventoryMissing');
      // Layout preparation may notice a deletion missed while the adapter was off.
      // Carry that bookkeeping revision into the same missing-node preview, without
      // changing the frozen native inventory or absorbing intervening user edits.
      for (const row of record.differences) if (row.kind === 'localDeleted' && !row.expected && row.representation) {
        const old = row.representation, latest = await db.read<Representation>('representations', representationKey(old));
        if (latest?.state === 'suppressed' && sourceDigest(latest.native) === sourceDigest(old.native)
          && sourceDigest(latest.lastWritten ?? null) === sourceDigest(old.lastWritten ?? null)) row.representation = latest;
      }
      const config = await db.read<{ ruleId: string }>('meta', `archiveConfig:${job.context.connectionId}`);
      const mount = config && await db.read<import('./layout.js').SourceMount>('mounts', sourceKey(job.context.connectionId, config.ruleId));
      const preview: ReconcilePreview = { version: 1, id: job.previewId!, importId: job.id, context: job.context, digest: '', createdAt: Date.now(),
        ...(mount ? { destination: { root: mount.root, owner: mount.destination ?? null } } : {}),
        policyRevision: job.snapshot!.policyRevision,
        snapshots: record.snapshots, differences: record.differences };
      preview.digest = sourceDigest(preview);
      await writeReconcileData(db, reconcileKey(job.id), preview);
    },
  };
}
