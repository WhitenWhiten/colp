import { exportSourceDiagnostic, diagnosticSummary } from './repair.js';
import { siteLedger } from './source-runtime.js';
import { createSourceRebinder, type RestoredSources } from './portable.js';
import { literal, object, str, jsonBytes } from './schema.js';
import { cursorPage } from '../sync-state/idb.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import { wakePlannedSaves } from './planned-runtime.js';
import type { SourceAuthority } from './ledger-types.js';
import type { SourceMount } from './layout.js';
const status = object({ kind: literal('known.siteAdapters.repair.status', 'known.siteAdapters.repair.export', 'known.siteAdapters.repair.recover') });
const rebind = object({ kind: literal('known.siteAdapters.repair.preview', 'known.siteAdapters.repair.approve'), restoreId: str(256),
  connectionRef: str(256), mountRef: str(256), digest: v => v === undefined || str(128)(v) });
const blockedReview = object({ kind: literal('known.siteAdapters.repair.reviewBlocked', 'known.siteAdapters.repair.retainBlocked'), restoreId: str(256),
  connectionRef: str(256), digest: v => v === undefined || str(128)(v) });
export const validRepairRequest = (raw: unknown) => jsonBytes(raw, 16384) && (status(raw) || rebind(raw) || blockedReview(raw));
const db = siteLedger.db;
const rebinder = createSourceRebinder(db, {
  authority: () => db.read<SourceAuthority>('authorities', 'bundled.bilibili'),
  async mount() {
    const a = await db.read<SourceAuthority>('authorities', 'bundled.bilibili');
    const config = a?.connectionId ? await db.read<{ ruleId: string }>('meta', `archiveConfig:${a.connectionId}`) : undefined;
    return config && a?.connectionId ? db.read<SourceMount>('mounts', JSON.stringify([a.connectionId, config.ruleId])) : undefined;
  }, deviceId: captureDeviceId,
  async lookup(id) { await assertPersonalNativeAllowed(id); return (await chrome.bookmarks.get(id).catch(() => []))[0] ?? null; },
});
export async function handleRepairRequest(raw: unknown) {
  if (!validRepairRequest(raw)) throw new Error('invalid');
  const r = raw as { kind: string; restoreId: string; connectionRef: string; mountRef: string; digest?: string };
  if (r.kind.endsWith('.export')) return { ok: true, diagnostic: await exportSourceDiagnostic() };
  if (r.kind.endsWith('.preview')) return { ok: true, preview: await rebinder.preview(r.restoreId, r.connectionRef, r.mountRef) };
  if (r.kind.endsWith('.reviewBlocked')) return { ok: true, preview: await rebinder.reviewBlocked(r.restoreId, r.connectionRef) };
  if (r.kind.endsWith('.retainBlocked')) {
    if (!r.digest) throw new Error('sourceRestorePreviewRequired');
    return { ok: true, result: await rebinder.retainBlocked(r.restoreId, r.connectionRef, r.digest) };
  }
  if (r.kind.endsWith('.approve')) {
    if (!r.digest) throw new Error('sourceRestorePreviewRequired');
    return { ok: true, result: await rebinder.approve(r.restoreId, r.connectionRef, r.mountRef, r.digest) };
  }
  if (r.kind.endsWith('.recover')) await wakePlannedSaves(); // Existing commands only; normal source/policy/approval fences still apply.
  const summary = diagnosticSummary(await exportSourceDiagnostic());
  let restored: RestoredSources[] = [];
  if (summary.supportedSchema && summary.schemaVersion) restored = await db.transaction(['meta'], 'readonly', async tx => {
    const records = await cursorPage<unknown>(tx.objectStore('meta'), IDBKeyRange.bound('restoredSources:', 'restoredSources:\uffff'), 101);
    if (records.length > 100) throw new Error('sourceRestoreListLimit');
    return records as RestoredSources[];
  });
  return { ok: true, ...summary, restored: restored.map(r => ({ id: r.id, state: r.state, connections: r.data.connections.map(c => ({ ref: c.ref,
    accountId: c.accountId, retainedBlocked: r.reviewed.includes(JSON.stringify([c.ref, '__blocked__'])), mounts: c.mounts.map(m => ({ ref: m.ref, rootCandidate: m.rootSourceId && r.nativeIds[m.rootSourceId] || null,
      reviewed: r.reviewed.includes(JSON.stringify([c.ref, m.ref])) })), associations: c.associations.length })) })) };
}
