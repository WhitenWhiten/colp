import { selectedSite, sendSiteMessage, mountSiteSelector, siteButton, siteRow, offer } from './settings-client.js';
import { hydrateIcons } from '../icons.js';
import { localizePage, onUiLanguageChanged, t, tn } from '../i18n.js';
hydrateIcons(document);
mountSiteSelector();
import './community-settings.js';
import './cloud-settings.js';
interface ImportStatus { id: string; phase: string; edgeCount: number; pages: number; omissions: number; coverage: string; reason: string | null; nextEdge: number; nextPlan: number;
  preview: { id: string; revision: number; digest: string; coverage: string; counts: { createFolders: number; createBookmarks: number; reuseBookmarks: number; review: number }; omissions?: { samples: readonly { id: string; reason: string }[]; unscannedRemainder: boolean } } | null }
interface SiteStatus { inspectionStatus?: { status: string; retryAfterMs?: number }; enabled?: boolean; connected?: boolean; documents?: number; candidateAccount?: string | null; error?: string;
  confirmations?: { pending: number; paused?: unknown }; archiveHold?: string | null;
  browser?: { minimum: number; major: number | null; supported: boolean }; grants?: { site: boolean; bookmarks: boolean };
  inspection?: { command: { deadlineAt: number; operation?: string; pageRequestId?: string; query?: { cursor: string | null } }; result?: { status: string; kind?: string; item?: { title?: string }; page?: { items: { id: string; title: string }[]; nextCursor: string | null } } };
  archive?: { config: { root: { nativeId: string }; collectionIds: readonly string[]; live: boolean; state: string; copies?: string; primarySourceCollectionId?: string | null; aiDestination?: string } | null; import: ImportStatus | null } }
const root = document.querySelector<HTMLSelectElement>('#archive-root')!, collections = document.querySelector<HTMLSelectElement>('#archive-collections')!;
let lastImport: ImportStatus | null = null, lastCatalog: string | undefined, lastConfig: string | undefined;
let activeRoot = '', nextCatalog: string | null = null;
let lastArchive: { collectionIds: readonly string[]; state: string } | null = null;
const collectionSelection = new Set<string>();
const catalogItems = new Map<string, { id: string; title: string }>();
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const text = (id: string, value: string) => { document.querySelector(`#${id}`)!.textContent = value; };
// Static copy is marked data-i18n; the lines that name the site are filled here. A language change reloads the page, as the options page does.
localizePage(); onUiLanguageChanged(() => location.reload());
const siteName = selectedSite.label;
text('sites-lede', selectedSite.negativeReadback
  ? t('sites_ledeWithNegativeReadback', 'Connect $1, inspect its collections, and choose a local archive root. Source archives use no AI. Membership removals can be verified; existing archives are retained.', siteName)
  : t('sites_lede', 'Connect $1, inspect its collections, and choose a local archive root. Source archives use no AI. Negative membership readback is unavailable; removals retain existing archives.', siteName));
text('inspector-title', t('sites_inspectorTitle', '$1 inspector', siteName));
text('inspector-hint', t('sites_inspectorHint', 'Reads the $1 pages you open. Needs Chrome 149 or later and access to the site.', siteName));
text('connection', t('sites_turnOnThenOpen', 'Turn on the inspector, then open $1 while signed in.', siteName));
text('sites-collections-lede', t('sites_collectionsLede', 'Read your collections and the current video from an open $1 tab.', siteName));
button('enable').setAttribute('aria-label', t('sites_enableInspector', 'Enable $1 inspector', siteName)); button('disable').setAttribute('aria-label', t('sites_disableInspector', 'Disable $1 inspector', siteName));
// Back to the settings pane the page was opened from.
if (document.referrer.startsWith(new URL('options.html', location.href).href)) document.querySelector<HTMLAnchorElement>('#sites-back')!.href = document.referrer;
// Settings switches are the kit's .toggle (role=switch), not checkboxes.
const switchOn = (id: string) => button(id).getAttribute('aria-checked') === 'true';
const setSwitch = (id: string, on: boolean) => button(id).setAttribute('aria-checked', String(on));
for (const id of ['archive-live', 'archive-ai']) button(id).addEventListener('click', () => setSwitch(id, !switchOn(id)));
const copies = document.querySelector<HTMLSelectElement>('#archive-copies')!;
// The primary collection only places a single source copy.
const paintCopies = () => { document.querySelector<HTMLElement>('#archive-primary-row')!.hidden = copies.value === 'sourceAndSemantic'; };
copies.addEventListener('change', paintCopies);
/** One warning at the top of the page; a code is never shown in a sentence (the full reply sits in Technical details). */
function showAlert(message: string | null) { text('site-alert-text', message ?? ''); document.querySelector<HTMLElement>('#site-alert')!.hidden = !message; }
const errorCopy = (code: string) => code === 'permissionRequired' ? t('sites_siteAccessRequired', 'Site access is required.')
  : code === 'browserUnsupported' ? t('sites_newerChrome', 'Site adapters need a newer version of Chrome.')
  : t('sites_pausedAlert', 'Site adapters are paused. Recovery inspection and export remain available.');
function phaseLabel(phase: string) {
  switch (phase) {
    case 'scanning': return t('sites_phaseScanning', 'Scanning');
    case 'paused': return t('sites_phasePaused', 'Scan stopped');
    case 'preparing': return t('sites_phasePreparing', 'Preparing the import');
    case 'preview': return t('sites_phasePreview', 'Preview ready');
    case 'approved': return t('sites_phaseApproved', 'Importing');
    case 'attention': return t('sites_phaseAttention', 'Needs review');
    case 'cancelled': return t('sites_phaseCancelled', 'Import cancelled');
    case 'completed': return t('sites_phaseCompleted', 'Import complete');
    default: return t('sites_phaseOther', 'Import');
  }
}
function paintImport(job: ImportStatus | null) {
  const badge = document.querySelector<HTMLElement>('#import-badge')!, omissions = document.querySelector<HTMLDetailsElement>('#import-omissions')!;
  text('import-state', job ? phaseLabel(job.phase) : t('sites_noImport', 'No import started'));
  badge.hidden = !job || !['preview', 'attention'].includes(job.phase) || !job.preview?.counts.review;
  if (job?.preview) { badge.textContent = tn('sites_toReview', job.preview.counts.review, '$1 to review', '$1 to review'); badge.dataset.tone = 'warning'; }
  const samples = job?.preview?.omissions?.samples ?? [];
  omissions.hidden = !samples.length; document.querySelector('#import-omission-list')!.replaceChildren(...samples.map(o => { const li = document.createElement('li'); li.textContent = o.reason; li.title = o.id; return li; }));
  if (!job) text('import-summary', t('sites_importFirst', 'Save archive settings, then scan the selected collections.'));
  else if (job.preview && ['preview', 'attention'].includes(job.phase)) { const c = job.preview.counts;
    text('import-summary', [job.coverage === 'complete' ? t('sites_previewComplete', 'Complete preview.') : t('sites_previewPartial', 'Partial preview.'),
      t('sites_previewCounts', 'New folders: $1 · New bookmarks: $2 · Existing copies: $3 · To review: $4.', c.createFolders, c.createBookmarks, c.reuseBookmarks, c.review),
      tn('sites_knownOmissions', job.omissions, '$1 known omission or read failure.', '$1 known omissions or read failures.'),
      ...job.preview.omissions?.unscannedRemainder ? [t('sites_unscannedUnknown', 'Unscanned remainder is unknown.')] : [], t('sites_noWritesYet', 'No import writes yet.')].join(' '));
  } else text('import-summary', [job.omissions ? t('sites_scanCountsOmissions', 'Memberships collected: $1 · Pages: $2 · Omissions: $3.', job.edgeCount, job.pages, job.omissions)
      : t('sites_scanCounts', 'Memberships collected: $1 · Pages: $2.', job.edgeCount, job.pages),
    ...job.nextPlan ? [t('sites_itemPlans', 'Item plans confirmed: $1.', job.nextPlan)] : [],
    ...job.phase === 'paused' ? [job.reason === 'scanFinished' ? t('sites_scanFinished', 'The scan finished; build the preview to review it.')
      : t('sites_scanStopped', 'The scan stopped early; restart it, or build a preview from what was found.')] : []].join(' '));
}
function renderArchive(result: SiteStatus) {
  const catalog = result.inspection;
  if (catalog?.result?.status === 'ok' && catalog.result.kind === 'collections' && catalog.result.page && catalog.command.pageRequestId !== lastCatalog) {
    lastCatalog = catalog.command.pageRequestId;
    if (!catalog.command.query?.cursor) catalogItems.clear();
    for (const c of catalog.result.page.items) catalogItems.set(c.id, c);
    nextCatalog = catalog.result.page.nextCursor; offer(button('next-catalog'), !!nextCatalog);
    text('catalog-summary', nextCatalog ? tn('sites_collectionsReadMore', catalogItems.size, '$1 collection read; more are available.', '$1 collections read; more are available.')
      : tn('sites_collectionsRead', catalogItems.size, '$1 collection read.', '$1 collections read.'));

    const primary = document.querySelector<HTMLSelectElement>('#archive-primary')!, chosenPrimary = primary.value;
    primary.replaceChildren(new Option(t('sites_askPrimary', 'Ask when multiple collections apply'), ''), ...Array.from(catalogItems.values()).map(c => new Option(c.title, c.id)));
    primary.value = chosenPrimary;
    collections.replaceChildren(...Array.from(catalogItems.values()).map(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.title;
      o.selected = collectionSelection.has(c.id); return o; }));
  }
  if (catalog?.command.operation === 'resolveItem' && catalog.result)
    text('item-summary', catalog.result.status !== 'resolved' ? t('sites_noVideo', 'No single video was found in the active tab.')
      : catalog.result.item?.title ? t('sites_foundVideo', 'Found “$1”.', catalog.result.item.title) : t('sites_foundThisVideo', 'Found this video.'));
  if (!result.archive) return;
  const { config, import: job } = result.archive; lastImport = job;
  const signature = JSON.stringify(config);
  if (signature !== lastConfig) { lastConfig = signature; collectionSelection.clear(); for (const id of config?.collectionIds ?? []) collectionSelection.add(id);
    for (const o of Array.from(collections.options)) o.selected = collectionSelection.has(o.value);
    activeRoot = config?.root.nativeId ?? '';
    if (Array.from(root.options).some(o => o.value === activeRoot)) root.value = activeRoot;
    setSwitch('archive-live', config?.live ?? false);
    copies.value = config?.copies ?? 'sourceAndSemantic'; paintCopies();
    document.querySelector<HTMLSelectElement>('#archive-primary')!.value = config?.primarySourceCollectionId ?? '';
    setSwitch('archive-ai', config?.aiDestination === 'allowed');
  }
  lastArchive = config; paintArchiveSummary();
  offer(button('disable-archive'), config?.state === 'active');
  offer(button('start-import'), config?.state === 'active' && (!job || ['cancelled', 'completed'].includes(job.phase)));
  offer(button('freeze-import'), !!job && ['scanning', 'paused', 'preview', 'attention'].includes(job.phase));
  button('freeze-import').textContent = job?.phase === 'preview' || job?.phase === 'attention' ? t('sites_refreshPreview', 'Refresh preview') : t('sites_buildPreview', 'Stop and build preview');
  offer(button('resume-import'), job?.phase === 'paused');
  offer(button('approve-import'), job?.phase === 'preview' && !!job.preview);
  offer(button('cancel-import'), !!job && !['cancelled', 'completed'].includes(job.phase));
  paintImport(job);
}
/** The archive card's foot line; the root's name arrives with the folder list, which may load after the status. */
function paintArchiveSummary() {
  const config = lastArchive, rootName = root.selectedOptions[0]?.value ? root.selectedOptions[0].textContent ?? '' : t('sites_theChosenRoot', 'the chosen root');
  text('archive-summary', !config ? t('sites_notArchiving', 'Not archiving yet.')
    : config.state === 'active' ? tn('sites_archivingInto', config.collectionIds.length, 'Archiving $1 collection into $2.', 'Archiving $1 collections into $2.', rootName)
    : config.state === 'pending' ? t('sites_archivePending', 'Saved. Waiting for the archive root.') : t('sites_archivePaused', 'Archives are paused.'));
}
async function loadRoots() {
  const grant = button('grant-archive'), allowed = await chrome.permissions.contains({ permissions: ['bookmarks'] });
  // Granted, the button only reloads the folder list.
  grant.className = allowed ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'; grant.textContent = allowed ? t('sites_reloadFolders', 'Reload folders') : t('common_allowBookmarkAccess', 'Allow bookmark access');
  root.disabled = !allowed; text('archive-root-hint', allowed ? t('sites_archiveRootHint', 'The bookmark folder that holds the archive.') : t('sites_allowToChoose', 'Allow bookmark access to choose a folder.'));
  if (!allowed) return;
  const selected = root.value || activeRoot; const options: HTMLOptionElement[] = [];
  const walk = (nodes: readonly chrome.bookmarks.BookmarkTreeNode[], path: string[]) => {
    for (const node of nodes) { if (node.url) continue; const next = node.title ? [...path, node.title] : path;
      if (node.parentId) { const o = document.createElement('option'); o.value = node.id; o.textContent = next.join(' / '); options.push(o); }
      walk(node.children ?? [], next);
    }
  };
  walk(await chrome.bookmarks.getTree(), []); root.replaceChildren(new Option(t('sites_chooseRoot', 'Choose a root'), ''), ...options); root.value = selected; paintArchiveSummary();
}
/** Inspector and account rows: what is on, who is connected and what to do next. */
function paintConnection(result: SiteStatus) {
  if (typeof result.enabled !== 'boolean') return;
  const site = selectedSite.label, granted = result.grants?.site ?? false, dot = document.querySelector<HTMLElement>('#inspector-dot')!;
  dot.dataset.tone = !result.enabled ? 'off' : granted ? 'on' : 'warning';
  text('inspector-state', !result.enabled ? t('sites_off', 'Off') : granted ? t('sites_on', 'On') : t('sites_needsSiteAccess', 'Needs site access'));
  button('enable').hidden = result.enabled && granted; button('disable').hidden = !result.enabled;
  document.querySelector<HTMLElement>('#account-value')!.hidden = !result.connected;
  text('connection', candidate ? t('sites_detectedAccount', 'Detected account $1. Confirm the account you want to connect.', candidate)
    : result.connected ? result.documents ? tn('sites_readingTabs', result.documents, 'Reading $1 open $2 tab.', 'Reading $1 open $2 tabs.', site) : t('sites_openToRead', 'Open $1 to read your collections.', site)
    : result.enabled ? t('sites_openSignedIn', 'Open $1 while signed in, then refresh status.', site) : t('sites_turnOnThenOpen', 'Turn on the inspector, then open $1 while signed in.', site));
  const waiting = result.confirmations?.pending ?? 0;
  text('confirmation-summary', waiting ? tn('sites_readsWaiting', waiting, '$1 read waiting.', '$1 reads waiting.')
    : result.confirmations?.paused ? t('sites_paused', 'Paused.') : t('sites_noneWaiting', 'None waiting.'));
}
const status = document.querySelector<HTMLPreElement>('#status')!;
const confirm = document.querySelector<HTMLButtonElement>('#confirm')!;
let candidate: string | null = null;
let inspectionRetry: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function send(message: unknown) {
  clearTimeout(refreshTimer);
  const result = await sendSiteMessage(message) as SiteStatus;
  candidate = result.candidateAccount ?? null; confirm.hidden = !candidate;
  status.textContent = JSON.stringify(result, null, 2);
  showAlert(result.error ? errorCopy(result.error) : !result.browser || result.browser.supported ? null
    : result.browser.major ? t('sites_chromeVersion', 'Site adapters need Chrome $1 or later; this is Chrome $2.', result.browser.minimum, result.browser.major)
    : t('sites_chromeMinimum', 'Site adapters need Chrome $1 or later.', result.browser.minimum));
  document.querySelector<HTMLElement>('#archive-hold')!.hidden = !result.archiveHold;
  if (result.browser) button('enable').disabled = !result.browser.supported;
  paintConnection(result);
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
  void chrome.permissions.request({ permissions: ['scripting', 'webNavigation'], origins: [...selectedSite.matches] }).then(granted => {
    if (granted) return send({ kind: 'known.siteAdapters.enable', enabled: true }); showAlert(t('sites_siteAccessRequired', 'Site access is required.'));
  }).catch(() => { showAlert(t('sites_siteAccessUnavailable', 'Site access is unavailable.')); });
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
  collectionIds: Array.from(collectionSelection), copies: copies.value,
  primarySourceCollectionId: document.querySelector<HTMLSelectElement>('#archive-primary')!.value || null, aiDestination: switchOn('archive-ai') ? 'allowed' : 'excluded', live: switchOn('archive-live') }); });
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
  const result = await sendSiteMessage({ kind: 'known.siteAdapters.content.list' }) as { ok?: boolean; connectionId?: string; truncated?: boolean;
    bindings?: { id: string; itemId: string; title: string; state: string; connectionId: string | null; native: boolean }[] };
  const container = document.querySelector('#content-bindings')!, bindings = result.bindings ?? []; container.replaceChildren();
  text('content-summary', !result.ok ? t('sites_associationsUnreadable', 'Couldn’t read saved associations.') : !bindings.length ? t('sites_noAssociations', 'No saved associations yet.')
    : [tn('sites_associationCount', bindings.length, '$1 saved association.', '$1 saved associations.'),
      ...result.truncated ? [t('sites_associationsTruncated', 'Only the first saved associations are shown; remaining records are retained.')] : []].join(' '));
  for (const b of bindings) {
    const other = !!result.connectionId && b.connectionId !== result.connectionId;
    const { row, text: copy, control } = siteRow(b.title, other ? t('sites_savedWithOther', 'Saved with another account.') : b.state === 'active' ? t('sites_savedWithConnected', 'Saved with the connected account.') : '');
    copy.title = b.itemId;
    if (b.state !== 'active') { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = b.state; control.append(badge); }
    if (b.native && b.state === 'active' && result.connectionId && b.connectionId !== result.connectionId) {
      const adopt = siteButton(t('sites_adoptCopy', 'Adopt this copy into the connected account'));
      adopt.onclick = () => { void sendSiteMessage({ kind: 'known.siteAdapters.content.adoptAccount', itemId: b.itemId, bindingId: b.id, allowAccountChange: true }).then(r => {
        status.textContent = JSON.stringify(r, null, 2); if ((r as { ok?: boolean }).ok) adopt.disabled = true;
      }); }; control.append(adopt);
    }
    container.append(row);
  }
})(); });

async function repair(kind: 'status' | 'recover' | 'export') {
  const result = await sendSiteMessage({ kind: `known.siteAdapters.repair.${kind}` }) as { ok?: boolean; error?: string; diagnostic?: unknown; attention?: unknown[];
    restored?: { id: string; connections: { ref: string; accountId: string; retainedBlocked: boolean; mounts: { ref: string; rootCandidate: string | null; reviewed: boolean }[] }[] }[] };
  const summary = document.querySelector('#repair-summary')!, container = document.querySelector('#repair-records')!, feedback = document.querySelector<HTMLElement>('#repair-feedback')!;
  feedback.hidden = true;
  if (result.diagnostic) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.diagnostic, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `colp-source-private-diagnostic-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); feedback.textContent = t('sites_diagnosticExported', 'Private diagnostic exported. Existing work and database schema were preserved.'); feedback.hidden = false; return;
  }
  summary.textContent = JSON.stringify(result, null, 2); container.replaceChildren();
  const attention = result.attention?.length ?? 0;
  text('repair-hint', !result.ok ? t('sites_repairUnreadable', 'Couldn’t read recovery records. The last response is below.')
    : attention ? tn('sites_recordsNeedRecovery', attention, '$1 record needs recovery or review.', '$1 records need recovery or review.') : t('sites_noRecords', 'No records need recovery.'));
  for (const restored of result.restored ?? []) for (const connection of restored.connections) {
    if (connection.retainedBlocked || connection.mounts.length && connection.mounts.every(m => m.reviewed)) continue;
    const { row, control } = siteRow(t('sites_restoredAccount', 'Restored account $1', connection.accountId),
      t('sites_restoredBlockedHint', 'Unresolved restored copies can remain blocked while unrelated new work continues.'), true);
    const preview = siteButton(t('sites_reviewBlocked', 'Review keeping this restored scope blocked'));
    preview.onclick = () => { void (async () => {
      const request = { restoreId: restored.id, connectionRef: connection.ref };
      const response = await sendSiteMessage({ kind: 'known.siteAdapters.repair.reviewBlocked', ...request }) as { preview?: { digest: string } };
      summary.textContent = JSON.stringify(response, null, 2);
      if (response.preview) { const approve = siteButton(t('sites_keepBlocked', 'Keep these restored items and collections blocked'), 'primary');
        approve.onclick = () => { approve.disabled = true; void sendSiteMessage({ kind: 'known.siteAdapters.repair.retainBlocked', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); }; control.append(approve); }
    })(); }; control.append(preview); container.append(row);
  }
  for (const restored of result.restored ?? []) for (const connection of restored.connections) for (const mount of connection.mounts) {
    const rootName = mount.rootCandidate && Array.from(root.options).find(o => o.value === mount.rootCandidate)?.textContent || mount.rootCandidate;
    const { row, control } = siteRow(t('sites_restoredAccount', 'Restored account $1', connection.accountId), [rootName ? t('sites_rootCandidate', 'Root candidate: $1.', rootName) : t('sites_noRootCandidate', 'No root candidate.'),
      mount.reviewed ? t('sites_reviewedSentence', 'Reviewed.') : t('sites_disabledUntilReviewed', 'Disabled until reviewed.')].join(' '), true);
    if (!mount.reviewed) { const preview = siteButton(t('sites_previewRebinding', 'Preview account and root rebinding'));
      preview.onclick = () => { void (async () => {
        const request = { restoreId: restored.id, connectionRef: connection.ref, mountRef: mount.ref };
        const response = await sendSiteMessage({ kind: 'known.siteAdapters.repair.preview', ...request }) as { preview?: { digest: string; review: string[] }; error?: string };
        summary.textContent = JSON.stringify(response, null, 2);
        if (response.preview && !response.preview.review.length) {
          const approve = siteButton(t('sites_adoptProven', 'Adopt these proven copies (no native writes)'), 'primary');
          approve.onclick = () => { approve.disabled = true; void sendSiteMessage({ kind: 'known.siteAdapters.repair.approve', ...request, digest: response.preview!.digest }).then(r => { summary.textContent = JSON.stringify(r, null, 2); }); };
          control.append(approve);
        }
      })(); }; control.append(preview); }
    else { const done = document.createElement('span'); done.className = 'set-row-value'; done.textContent = t('sites_reviewed', 'Reviewed'); control.append(done); }
    container.append(row);
  }
}
for (const kind of ['status', 'recover', 'export'] as const) button(`repair-${kind}`).addEventListener('click', () => { void repair(kind).catch(e => { document.querySelector('#repair-summary')!.textContent = String(e); }); });
