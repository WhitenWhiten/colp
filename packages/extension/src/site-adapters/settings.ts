import { BILIBILI } from './bilibili/identity.js';
import './community-settings.js';
import './cloud-settings.js';
interface ImportStatus { id: string; phase: string; edgeCount: number; pages: number; omissions: number; coverage: string; reason: string | null; nextEdge: number; nextPlan: number;
  preview: { id: string; revision: number; digest: string; coverage: string; counts: { createFolders: number; createBookmarks: number; reuseBookmarks: number; review: number }; omissions?: { samples: readonly { id: string; reason: string }[]; unscannedRemainder: boolean } } | null }
interface SiteStatus { inspectionStatus?: { status: string; retryAfterMs?: number }; candidateAccount?: string | null; error?: string; confirmations?: { pending: number };
  browser?: { minimum: number; major: number | null; supported: boolean }; grants?: { site: boolean; bookmarks: boolean };
  inspection?: { command: { deadlineAt: number; pageRequestId?: string; query?: { cursor: string | null } }; result?: { status: string; kind?: string; page?: { items: { id: string; title: string }[]; nextCursor: string | null } } };
  archive?: { config: { root: { nativeId: string }; collectionIds: readonly string[]; live: boolean; state: string; copies?: string; primarySourceCollectionId?: string | null; aiDestination?: string } | null; import: ImportStatus | null } }
const root = document.querySelector<HTMLSelectElement>('#archive-root')!, collections = document.querySelector<HTMLSelectElement>('#archive-collections')!;
let lastImport: ImportStatus | null = null, lastCatalog: string | undefined, lastConfig: string | undefined;
let activeRoot = '', nextCatalog: string | null = null;
const collectionSelection = new Set<string>();
const catalogItems = new Map<string, { id: string; title: string }>();
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
function renderArchive(result: SiteStatus) {
  const catalog = result.inspection;
  if (catalog?.result?.status === 'ok' && catalog.result.kind === 'collections' && catalog.result.page && catalog.command.pageRequestId !== lastCatalog) {
    lastCatalog = catalog.command.pageRequestId;
    if (!catalog.command.query?.cursor) catalogItems.clear();
    for (const c of catalog.result.page.items) catalogItems.set(c.id, c);
    nextCatalog = catalog.result.page.nextCursor; button('next-catalog').disabled = !nextCatalog;

    const primary = document.querySelector<HTMLSelectElement>('#archive-primary')!, chosenPrimary = primary.value;
    primary.replaceChildren(new Option('Ask when multiple collections apply', ''), ...Array.from(catalogItems.values()).map(c => new Option(c.title, c.id)));
    primary.value = chosenPrimary;
    collections.replaceChildren(...Array.from(catalogItems.values()).map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.title;
      o.selected = collectionSelection.has(c.id); return o; }));
  }
  if (!result.archive) return;
  const { config, import: job } = result.archive; lastImport = job;
  const signature = JSON.stringify(config);
  if (signature !== lastConfig) { lastConfig = signature; collectionSelection.clear(); for (const id of config?.collectionIds ?? []) collectionSelection.add(id);
    for (const o of Array.from(collections.options)) o.selected = collectionSelection.has(o.value);
    activeRoot = config?.root.nativeId ?? '';
    if (Array.from(root.options).some(o => o.value === activeRoot)) root.value = activeRoot;
    document.querySelector<HTMLInputElement>('#archive-live')!.checked = config?.live ?? false;
    document.querySelector<HTMLSelectElement>('#archive-copies')!.value = config?.copies ?? 'sourceAndSemantic';
    document.querySelector<HTMLSelectElement>('#archive-primary')!.value = config?.primarySourceCollectionId ?? '';
    document.querySelector<HTMLInputElement>('#archive-ai')!.checked = config?.aiDestination === 'allowed';
  }
  button('start-import').disabled = config?.state !== 'active' || !!job && !['cancelled', 'completed'].includes(job.phase);
  button('freeze-import').disabled = !job || !['scanning', 'paused', 'preview', 'attention'].includes(job.phase);
  button('freeze-import').textContent = job?.phase === 'preview' || job?.phase === 'attention' ? 'Refresh preview' : 'Stop and build preview';
  button('resume-import').disabled = job?.phase !== 'paused';
  button('approve-import').disabled = job?.phase !== 'preview' || !job.preview;
  button('cancel-import').disabled = !job || ['cancelled', 'completed'].includes(job.phase);
  const summary = document.querySelector('#import-summary')!;
  if (!job) summary.textContent = 'No import started.';
  else if (job.phase === 'preview' && job.preview) { const c = job.preview.counts;
    summary.textContent = `${job.coverage} preview: ${c.createFolders} new folders, ${c.createBookmarks} new bookmarks, ${c.reuseBookmarks} existing copies, ${c.review} requiring review. ${job.omissions} known omissions/read failures.${job.preview.omissions?.unscannedRemainder ? ' Unscanned remainder is unknown.' : ''} No import writes yet. ${job.preview.omissions?.samples.map(o => `${o.id}: ${o.reason}`).join('; ') ?? ''}`;
  } else summary.textContent = `${job.phase}: ${job.edgeCount} collected memberships, ${job.pages} pages, ${job.omissions} omissions (${job.coverage}). ${job.nextPlan} item plans confirmed.${job.reason ? ` ${job.reason}` : ''}`;
}
async function loadRoots() {
  if (!await chrome.permissions.contains({ permissions: ['bookmarks'] })) return;
  const selected = root.value || activeRoot; const options: HTMLOptionElement[] = [];
  const walk = (nodes: readonly chrome.bookmarks.BookmarkTreeNode[], path: string[]) => {
    for (const node of nodes) { if (node.url) continue; const next = node.title ? [...path, node.title] : path;
      if (node.parentId) { const o = document.createElement('option'); o.value = node.id; o.textContent = next.join(' / '); options.push(o); }
      walk(node.children ?? [], next);
    }
  };
  walk(await chrome.bookmarks.getTree(), []); root.replaceChildren(new Option('Choose a root', ''), ...options); root.value = selected;
}
const status = document.querySelector<HTMLPreElement>('#status')!;
const confirm = document.querySelector<HTMLButtonElement>('#confirm')!;
let candidate: string | null = null;
let inspectionRetry: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function send(message: unknown) {
  clearTimeout(refreshTimer);
  const result = await chrome.runtime.sendMessage(message) as SiteStatus;
  candidate = result.candidateAccount ?? null; confirm.hidden = !candidate;
  document.querySelector('#connection')!.textContent = candidate ? `Detected account ${candidate}. Confirm the account you want to connect.` : '';
  status.textContent = JSON.stringify(result, null, 2);
  document.querySelector('#capability-summary')!.textContent = result.error ? `Paused: ${result.error}. Recovery inspection and export remain available.`
    : `Chrome ${result.browser?.major ?? 'unknown'}; adapters require ${result.browser?.minimum ?? 149}+. Site access: ${result.grants?.site ? 'granted' : 'missing'}. Bookmarks: ${result.grants?.bookmarks ? 'granted' : 'missing'}. Positive observation only; human-action proof, negative readback, short links and cloud archives are unavailable.`;
  if (result.browser) button('enable').disabled = !result.browser.supported;
  renderArchive(result);
  if (result.archive?.import && ['scanning', 'preparing', 'approved'].includes(result.archive.import.phase) || result.confirmations?.pending || result.inspection && !result.inspection.result && result.inspection.command.deadlineAt > Date.now())
    refreshTimer = setTimeout(() => { void send({ kind: 'known.siteAdapters.status' }); }, 500);
  return result;
}
async function requestInspection(message: unknown, until = Date.now() + 30000) {
  clearTimeout(inspectionRetry);
  const result = await send(message);
  if (result.inspectionStatus?.status === 'paused' && Date.now() < until)
    inspectionRetry = setTimeout(() => { void requestInspection(message, until); }, Math.max(500, result.inspectionStatus.retryAfterMs ?? 1500));
}
document.querySelector('#enable')!.addEventListener('click', () => {
  void chrome.permissions.request({ permissions: ['scripting', 'webNavigation'], origins: [...BILIBILI.matches] }).then(granted => {
    if (granted) return send({ kind: 'known.siteAdapters.enable', enabled: true }); status.textContent = 'Site access is required.';
  }).catch(() => { status.textContent = 'Site access is unavailable.'; });
});
document.querySelector('#disable')!.addEventListener('click', () => { void send({ kind: 'known.siteAdapters.enable', enabled: false }); });
document.querySelector('#refresh')!.addEventListener('click', () => { void send({ kind: 'known.siteAdapters.status' }); });
confirm.addEventListener('click', () => { if (candidate) void send({ kind: 'known.siteAdapters.confirm', accountId: candidate }); });
void send({ kind: 'known.siteAdapters.status' });

document.querySelector('#read-catalog')!.addEventListener('click', () => { void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'collections' }); });
document.querySelector('#read-item')!.addEventListener('click', () => { void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'resolve' }); });

document.querySelector('#retry-confirmation')!.addEventListener('click', () => { void send({ kind: 'known.siteAdapters.retryConfirmation' }); });

button('grant-archive').addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(granted => { if (granted) return loadRoots(); }); });
button('configure-archive').addEventListener('click', () => { void send({ kind: 'known.siteAdapters.archive.configure', rootNativeId: root.value,
  collectionIds: Array.from(collectionSelection), copies: document.querySelector<HTMLSelectElement>('#archive-copies')!.value,
  primarySourceCollectionId: document.querySelector<HTMLSelectElement>('#archive-primary')!.value || null, aiDestination: document.querySelector<HTMLInputElement>('#archive-ai')!.checked ? 'allowed' : 'excluded', live: document.querySelector<HTMLInputElement>('#archive-live')!.checked }); });
button('disable-archive').addEventListener('click', () => { void send({ kind: 'known.siteAdapters.archive.disable' }); });
button('start-import').addEventListener('click', () => { void send({ kind: 'known.siteAdapters.import.start' }); });
button('freeze-import').addEventListener('click', () => { if (lastImport) void send({ kind: 'known.siteAdapters.import.freeze', jobId: lastImport.id }); });
button('resume-import').addEventListener('click', () => { if (lastImport) void send({ kind: 'known.siteAdapters.import.resume', jobId: lastImport.id }); });
button('cancel-import').addEventListener('click', () => { if (lastImport) void send({ kind: 'known.siteAdapters.import.cancel', jobId: lastImport.id }); });
button('approve-import').addEventListener('click', () => { const p = lastImport?.preview; if (p && lastImport) { button('approve-import').disabled = true;
  void send({ kind: 'known.siteAdapters.import.approve', jobId: lastImport.id, previewId: p.id, revision: p.revision, digest: p.digest }); } });
void loadRoots();

button('next-catalog').addEventListener('click', () => { if (nextCatalog) void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'collections', cursor: nextCatalog }); });

collections.addEventListener('change', () => { for (const o of Array.from(collections.options)) { if (o.selected) collectionSelection.add(o.value); else collectionSelection.delete(o.value); } });

button('read-bindings').addEventListener('click', () => { void (async () => {
  const result = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.content.list' }) as { ok?: boolean; connectionId?: string; truncated?: boolean;
    bindings?: { id: string; itemId: string; title: string; state: string; connectionId: string | null; native: boolean }[] };
  const container = document.querySelector('#content-bindings')!; container.replaceChildren();
  for (const b of result.bindings ?? []) {
    const row = document.createElement('p'); row.textContent = `${b.title} (${b.itemId}): ${b.state}. `;
    if (b.native && b.state === 'active' && result.connectionId && b.connectionId !== result.connectionId) {
      const adopt = document.createElement('button'); adopt.type = 'button'; adopt.textContent = 'Adopt this copy into the connected account';
      adopt.onclick = () => { void chrome.runtime.sendMessage({ kind: 'known.siteAdapters.content.adoptAccount', itemId: b.itemId, bindingId: b.id, allowAccountChange: true }).then(r => {
        status.textContent = JSON.stringify(r, null, 2); if ((r as { ok?: boolean }).ok) adopt.disabled = true;
      }); }; row.append(adopt);
    }
    container.append(row);
  }
  if (result.truncated) container.append(document.createTextNode('Only the first saved associations are shown. Remaining records are retained.'));
})(); });

async function repair(kind: 'status' | 'recover' | 'export') {
  const result = await chrome.runtime.sendMessage({ kind: `known.siteAdapters.repair.${kind}` }) as { ok?: boolean; error?: string; diagnostic?: unknown;
    restored?: { id: string; connections: { ref: string; accountId: string; retainedBlocked: boolean; mounts: { ref: string; rootCandidate: string | null; reviewed: boolean }[] }[] }[] };
  const summary = document.querySelector('#repair-summary')!, container = document.querySelector('#repair-records')!;
  if (result.diagnostic) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.diagnostic, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `colp-source-private-diagnostic-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); summary.textContent = 'Private diagnostic exported. Existing work and database schema were preserved.'; return;
  }
  summary.textContent = JSON.stringify(result, null, 2); container.replaceChildren();
  for (const restored of result.restored ?? []) for (const connection of restored.connections) {
    if (connection.retainedBlocked || connection.mounts.length && connection.mounts.every(m => m.reviewed)) continue;
    const row = document.createElement('p'), preview = document.createElement('button'); preview.type = 'button';
    row.textContent = `Account ${connection.accountId}: unresolved restored copies can remain blocked while unrelated new work continues. `;
    preview.textContent = 'Review keeping this restored scope blocked';
    preview.onclick = () => { void (async () => {
      const request = { restoreId: restored.id, connectionRef: connection.ref };
      const response = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.repair.reviewBlocked', ...request }) as { preview?: { digest: string } };
      summary.textContent = JSON.stringify(response, null, 2);
      if (response.preview) { const approve = document.createElement('button'); approve.type = 'button'; approve.textContent = 'Keep these restored items and collections blocked';
        approve.onclick = () => { approve.disabled = true; void chrome.runtime.sendMessage({ kind: 'known.siteAdapters.repair.retainBlocked', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); }; row.append(approve); }
    })(); }; row.append(preview); container.append(row);
  }
  for (const restored of result.restored ?? []) for (const connection of restored.connections) for (const mount of connection.mounts) {
    const row = document.createElement('p'); row.textContent = `Restored account ${connection.accountId}; root candidate ${mount.rootCandidate ?? 'unavailable'}. ${mount.reviewed ? 'Reviewed.' : 'Disabled until reviewed.'} `;
    if (!mount.reviewed) { const preview = document.createElement('button'); preview.textContent = 'Preview account and root rebinding'; preview.type = 'button';
      preview.onclick = () => { void (async () => {
        const request = { restoreId: restored.id, connectionRef: connection.ref, mountRef: mount.ref };
        const response = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.repair.preview', ...request }) as { preview?: { digest: string; review: string[] }; error?: string };
        summary.textContent = JSON.stringify(response, null, 2);
        if (response.preview && !response.preview.review.length) {
          const approve = document.createElement('button'); approve.textContent = 'Adopt these proven copies (no native writes)'; approve.type = 'button';
          approve.onclick = () => { approve.disabled = true; void chrome.runtime.sendMessage({ kind: 'known.siteAdapters.repair.approve', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); };
          row.append(approve);
        }
      })(); }; row.append(preview); }
    container.append(row);
  }
}
for (const kind of ['status', 'recover', 'export'] as const) button(`repair-${kind}`).addEventListener('click', () => { void repair(kind).catch(e => { document.querySelector('#repair-summary')!.textContent = String(e); }); });
