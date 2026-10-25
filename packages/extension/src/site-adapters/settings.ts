import { siteFeatures } from './capabilities.js';
import { renderSiteCapabilities } from './settings-capabilities.js';
import { selectedSite, sendSiteMessage, mountSiteNav, paintSiteNav, mountRoutes, onRoute, currentRoute, showTab, offer } from './settings-client.js';
import { createFolderPicker, folderChoices, type FolderPicker } from '../library-folder-picker.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { optionRow } from '../library-dom.js';
import { hydrateIcons } from '../icons.js';
import { localizePage, onUiLanguageChanged, t, tn } from '../i18n.js';
import { showToast } from '../toast.js';
import './settings-recovery.js';
import './settings-reconcile-history.js';
import './community-settings.js';
import './cloud-settings.js';
import { paintReconciliation, installReconcileControls, reconcileSelections } from './settings-reconcile.js';
import type { ReconcilePreview } from './reconcile-model.js';
import type { ReconcileRun } from './reconcile-run.js';
interface Collection { id: string; title: string }
interface ImportStatus { id: string; phase: string; edgeCount: number; pages: number; omissions: number; coverage: string; reason: string | null; nextEdge: number; nextPlan: number;
  preview: { id: string; revision: number; digest: string; coverage: string; counts: { createFolders: number; createBookmarks: number; reuseBookmarks: number; review: number }; omissions?: { samples: readonly { id: string; reason: string }[]; unscannedRemainder: boolean } } | null }
interface ArchiveConfig { root: { nativeId: string }; collectionIds: readonly string[]; live: boolean; state: string; copies?: string; primarySourceCollectionId?: string | null; aiDestination?: string; semantic?: string }
interface SemanticStatus { pending: number; attention: number; completed: number; suppressed: number;
  jobs: { id: string; title: string; state: string; reason: string | null; takeover: boolean }[] }
interface SiteStatus { inspectionStatus?: { status: string; retryAfterMs?: number }; enabled?: boolean; connected?: boolean; accountId?: string | null; documents?: number; candidateAccount?: string | null; error?: string;
  confirmations?: { pending: number; paused?: unknown }; archiveHold?: string | null;
  browser?: { minimum: number; major: number | null; supported: boolean }; grants?: { site: boolean; bookmarks: boolean };
  catalog?: { items: Collection[]; nextCursor: string | null; reading: boolean; current: boolean; failed: string | null } | null;
  inspection?: { command: { deadlineAt: number; operation?: string }; result?: { status: string; item?: { title?: string } } } | null;
  archive?: { catalog?: Collection[]; config: ArchiveConfig | null; import: ImportStatus | null; semantic?: SemanticStatus | null; reconciliation?: ReconcilePreview | null; reconciliationRun?: ReconcileRun | null } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const button = (id: string) => $<HTMLButtonElement>(id);
const text = (id: string, value: string) => { $(id).textContent = value; };
// Static copy is marked data-i18n; the lines that name the site are filled here. A language change reloads the page, as the options page does.
localizePage(); onUiLanguageChanged(() => location.reload());
hydrateIcons(document); mountSiteNav(); mountRoutes();
const site = selectedSite.label, features = siteFeatures(selectedSite);
text('site-title', site);
text('sites-lede', t('sites_ledeSync', 'Keep your $1 favorites as bookmarks in this browser.', site));
text('archive-live-hint', t('sites_keepSyncingHint', 'Favorites you add on $1 are saved here as you add them.', site));
for (const id of ['open-site-label', 'open-site-list-label']) text(id, t('sites_openSite', 'Open $1', site));
text('create-root-label', t('sites_newFolderNamed', 'New folder “$1”', site));
renderSiteCapabilities(document, selectedSite);
// Back to the settings pane the page was opened from.
if (document.referrer.startsWith(new URL('options.html', location.href).href)) $<HTMLAnchorElement>('sites-back').href = document.referrer;

/** Words for a worker code. A code never appears in a sentence; the full reply is in Recovery › Technical details. */
function errorCopy(code: string | undefined) {
  switch (code) {
    case 'permissionRequired': return t('sites_accessRequired', 'Know-N needs access first. Allow it, then try again.');
    case 'browserUnsupported': return t('sites_newerChrome', 'Site adapters need a newer version of Chrome.');
    case 'pageUnavailable': case 'restartRequired': case 'navigationChanged': return t('sites_openSiteFirst', 'Open $1 in a tab, then try again.', site);
    case 'refreshCatalogRequired': case 'staleCursor': return t('sites_collectionsChanged', 'Your collections changed. Check the list, then try again.');
    case 'bindingUnavailable': return t('sites_folderGone', 'That folder is gone. Choose another one.');
    case 'invalidPrimaryCollection': return t('sites_primaryNotChosen', 'The primary collection must be one of the collections you chose.');
    case 'chooseArchiveRoot': return t('sites_chooseFolder', 'Choose a folder.');
    case 'importAlreadyActive': return t('sites_importRunning', 'An import is already running.');
    case 'previewStale': return t('sites_previewChanged', 'Something changed since the list was made. It has been made again; check it before adding.');
    case 'signedOut': return t('sites_signedOut', 'You’re signed out of $1. Sign in there, then try again.', site);
    case 'rateLimited': return t('sites_rateLimited', '$1 asked Know-N to slow down. Try again in a few minutes.', site);
    case 'ruleRejected': return t('sites_ruleRejected', 'This browser’s rules couldn’t take the archive rule. Check Automations, then try again.');
    case 'sourceAutomationPaused': return t('sites_automationsPaused', 'Automations are paused in this browser. Resume them, then try again.');
    case 'sourceCloudUnsupported': return t('sites_refreshSyncedPreview', 'This folder now participates in sync. Make the import preview again before saving.');
    case 'sourceSyncUpgradeRequired': return t('sites_syncServerUpgrade', 'Update COLP Server to support saving website collections into synced folders.');
    case 'sourceDestinationChanged': case 'sourceDestinationNeedsReview': return t('sites_destinationChanged', 'The sync account or folder range changed. Check this folder and save the settings again.');
    case 'mountMigrationRequired': return t('sites_mappingMoveReview', 'This mapping already has saved bookmarks. Keep its current folder until those bookmarks can be moved together.');
    case 'sourceDestinationMigrationRequired': return t('sites_ownerMigrationReview', 'This mapping already contains bookmarks from another sync account or range. Return to that account and range before continuing.');
    case 'source_mapping_migration_required': case 'source_identity_migration_required': case 'source_legacy_association_review_required': case 'source_managed_copy_review_required':
      return t('sites_copyMigrationReview', 'Existing website copies need a mapping or identity review before saving can continue. No additional copies were created.');
    case 'semanticDestinationOutsideLibrary': return t('sites_semanticOutsideLibrary', 'AI chose a folder outside this sync library. Choose topic folders inside this library, then retry classification.');
    case 'local_key_required': return t('sites_semanticKeyRequired', 'Configure and enable your AI provider in Settings, then retry this copy.');
    case 'semanticOtherDevice': return t('sites_semanticOtherDevice', 'Another browser is handling this copy. Taking over starts a new classification attempt.');
    case 'semanticResultUnknown': case 'local_result_unavailable': return t('sites_semanticUnknown', 'The classification result was not received. Retry explicitly to make a new attempt.');
    case 'semanticChooseFolder': case 'semanticDestinationMapped': return t('sites_semanticChooseFolder', 'AI did not choose an available folder outside the website mappings. Check your folders and retry.');
    case 'semanticOffline': case 'sourceSyncPending': return t('sites_semanticWaiting', 'Waiting for the connection and bookmark sync.');
    case 'sourceCopySuppressed': return t('sites_semanticSuppressed', 'This copy was deleted. It will stay deleted.');
    case 'sourceCopyDetached': case 'semanticBindingNeedsReview': return t('sites_semanticReview', 'This copy was changed or its old association needs review. Existing bookmarks are kept.');
    case 'semanticPaused': return t('sites_semanticPaused', 'Paused because the source account or settings changed.');
    default: return t('sites_actionFailed', 'That didn’t work. The details are in Recovery › Technical details.');
  }
}
/** One notice at the top of the page, for what blocks the whole site; a step's own result is a toast. */
function showAlert(message: string | null) { text('site-alert-text', message ?? ''); $('site-alert').hidden = !message; }
function statusAlert(s: SiteStatus) {
  if (s.error) return s.error === 'browserUnsupported' ? errorCopy(s.error) : t('sites_pausedAlert', 'Site adapters are paused. Recovery inspection and export remain available.');
  if (!s.browser || s.browser.supported) return null;
  return s.browser.major ? t('sites_chromeVersion', 'Site adapters need Chrome $1 or later; this is Chrome $2.', s.browser.minimum, s.browser.major)
    : t('sites_chromeMinimum', 'Site adapters need Chrome $1 or later.', s.browser.minimum);
}

let status: SiteStatus = {};
installReconcileControls(message => act(message), () => { if (lastImport) paintImport(lastImport); });
let lastActionError: { operation: string; error: string; at: number } | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined, inspectionRetry: ReturnType<typeof setTimeout> | undefined;
/** The worker answers with the full status; a message nothing answers comes back as a refusal, never as silence. */
async function request(message: unknown): Promise<SiteStatus> {
  try { return (await sendSiteMessage(message) as SiteStatus | undefined) ?? { error: 'unavailable' }; } catch { return { error: 'unavailable' }; }
}
async function refresh() { return apply(await request({ kind: 'known.siteAdapters.status' })); }
/** Run a step. A refusal is a toast, and the page repaints from a fresh status. */
async function act(message: unknown, done?: () => void): Promise<boolean> {
  clearTimeout(refreshTimer);
  const result = await request(message);
  const action = message as { kind: string };
  if (result.error) {
    lastActionError = { operation: action.kind, error: result.error, at: Date.now() };
    showToast(errorCopy(result.error), 'error', { announce: true }); await refresh(); return false;
  }
  if (lastActionError?.operation === action.kind) lastActionError = undefined;
  done?.(); apply(result); return true;
}
function apply(result: SiteStatus) {
  clearTimeout(refreshTimer);
  $('status').textContent = JSON.stringify({ ...result, ...(lastActionError ? { lastActionError } : {}) }, null, 2);
  showAlert(statusAlert(result)); paintSiteNav(selectedSite.adapterId, result);
  if (result.error) return result;
  status = result; paint(); schedule(); return result;
}
/** Poll while something moves (a scan, a read, a confirmation) or while waiting for a tab or an account. */
function schedule() {
  const job = status.archive?.import;
  const busy = job && ['scanning', 'preparing', 'approved'].includes(job.phase) || !!status.confirmations?.pending || !!status.catalog?.reading
    || !!status.inspection && !status.inspection.result && status.inspection.command.deadlineAt > Date.now() || !!status.archive?.semantic?.pending
    || !!status.archive?.reconciliationRun?.operations.some(op => op.state === 'pending');
  const waiting = !!status.enabled && (!status.connected || !status.documents);
  if (busy || waiting) refreshTimer = setTimeout(() => { if (document.visibilityState === 'visible') void refresh(); }, busy ? 500 : 2000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
/** Ask for a read, waiting out a busy read slot for up to 30 seconds; `gaveUp` runs if it never started. */
async function requestInspection(message: unknown, until = Date.now() + 30000, gaveUp?: () => void) {
  clearTimeout(inspectionRetry);
  const result = await request(message);
  if (result.error) { showToast(errorCopy(result.error), 'error', { announce: true }); await refresh(); return; }
  apply(result);
  if (result.inspectionStatus?.status !== 'paused') return;
  if (Date.now() < until) inspectionRetry = setTimeout(() => { void requestInspection(message, until, gaveUp); }, Math.max(500, result.inspectionStatus.retryAfterMs ?? 1500));
  else gaveUp?.();
}
const openSite = () => { void chrome.tabs.create({ url: selectedSite.origin }); };
for (const id of ['open-site', 'open-site-list']) button(id).addEventListener('click', openSite);

// ---- Step 1: connect
function paintConnection() {
  const s = status, enabled = !!s.enabled, granted = s.grants?.site ?? false, candidate = s.candidateAccount ?? null, connected = !!s.connected && !candidate, docs = s.documents ?? 0;
  const title = !enabled ? t('sites_turnOnSite', 'Turn on $1', site) : !granted ? t('sites_needsAccess', '$1 needs site access', site)
    : candidate ? t('sites_signedInAs', 'Signed in to $1 as $2', site, candidate) : connected ? s.accountId ? t('sites_accountNamed', '$1 account $2', site, s.accountId) : t('sites_connected', 'Connected')
    : t('sites_openAndSignIn', 'Open $1 and sign in', site);
  const hint = !enabled ? t('sites_turnOnHint', 'Know-N reads your favorites from the $1 tabs you open. It never changes anything on $1.', site)
    : !granted ? t('sites_needsAccessHint', 'Allow access to $1 so Know-N can read your favorites.', new URL(selectedSite.origin).hostname)
    : candidate ? t('sites_connectHint', 'Connect this account to sync its collections.')
    : connected ? docs ? tn('sites_readingTabs', docs, 'Reading $1 open $2 tab.', 'Reading $1 open $2 tabs.', site) : t('sites_noTabOpen', 'No $1 tab is open. Open one when you want to read your collections.', site)
    : t('sites_openSignedInHint', 'Know-N finds your account in an open $1 tab.', site);
  text('connection-title', title); text('connection', hint);
  $('account-value').hidden = !connected;
  const enable = button('enable'); enable.textContent = enabled && !granted ? t('sites_allowAccess', 'Allow access') : t('sites_turnOn', 'Turn on');
  enable.hidden = enabled && granted; enable.disabled = !!s.browser && !s.browser.supported;
  button('confirm').hidden = !candidate; button('disable').hidden = !enabled;
  button('open-site').hidden = !enabled || !granted || !!candidate || connected && docs > 0;
  // An extra tab to open is secondary to connecting the account.
  button('open-site').className = !connected ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
}
button('enable').addEventListener('click', () => {
  void chrome.permissions.request({ permissions: ['scripting', 'webNavigation'], origins: [...selectedSite.matches] }).then(granted => {
    if (granted) return act({ kind: 'known.siteAdapters.enable', enabled: true }); showToast(t('sites_siteAccessRequired', 'Site access is required.'), 'error', { announce: true });
  }).catch(() => { showToast(t('sites_siteAccessUnavailable', 'Site access is unavailable.'), 'error', { announce: true }); });
});
button('disable').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.enable', enabled: false }); });
button('confirm').addEventListener('click', () => { const account = status.candidateAccount; if (account) void act({ kind: 'known.siteAdapters.confirm', accountId: account }); });
button('refresh').addEventListener('click', () => { void refresh(); });

// ---- Step 2: choose collections and a folder
const selection = new Set<string>();
let formRoot = '', primaryValue = '', dirty = false, configSignature: string | undefined, listSignature: string | undefined;
let picker: FolderPicker | null = null;
const switchOn = (id: string) => button(id).getAttribute('aria-checked') === 'true';
const setSwitch = (id: string, on: boolean) => button(id).setAttribute('aria-checked', String(on));
const copies = $<HTMLSelectElement>('archive-copies'), primary = $<HTMLSelectElement>('archive-primary'), list = $('archive-collections'), filter = $<HTMLInputElement>('collection-filter');
const edited = () => { dirty = true; paintForm(); };
for (const id of ['archive-live', 'archive-ai', 'archive-semantic']) button(id).addEventListener('click', () => { setSwitch(id, !switchOn(id)); edited(); });
// The primary collection only places a single source copy.
const paintCopies = () => { $('archive-primary-row').hidden = copies.value === 'sourceAndSemantic'; $('archive-semantic-row').hidden = copies.value !== 'sourceAndSemantic'; };
copies.addEventListener('change', () => { paintCopies(); edited(); });
primary.addEventListener('change', () => { primaryValue = primary.value; edited(); });
const rootValue = () => picker?.value() ?? formRoot;
const catalogItems = (): readonly Collection[] => features.collections ? status.catalog?.items ?? [] : status.archive?.catalog ?? [];
/** What Save sends: the ticked collections still in the list (one deleted on the site drops out). */
const chosenIds = () => { const items = catalogItems(); return items.length ? items.filter(c => selection.has(c.id)).map(c => c.id) : [...selection]; };
/** The saved settings fill the form, unless the person has started changing it. */
function loadConfig(config: ArchiveConfig | null) {
  const signature = JSON.stringify(config); if (signature === configSignature) return; configSignature = signature;
  if (dirty) return;
  selection.clear(); for (const id of config?.collectionIds ?? []) selection.add(id); listSignature = undefined;
  formRoot = config?.root.nativeId ?? ''; if (picker) picker.setValue(formRoot);
  setSwitch('archive-live', features.liveArchive && (config?.live ?? true));
  copies.value = config?.copies ?? 'sourceAndSemantic'; paintCopies();
  primaryValue = config?.primarySourceCollectionId ?? ''; primary.value = primaryValue;
  setSwitch('archive-ai', config?.aiDestination === 'allowed');
  setSwitch('archive-semantic', config?.semantic === 'automatic');
}
function paintCollections() {
  const items = catalogItems(), c = status.catalog, docs = status.documents ?? 0, connected = !!status.connected && !status.candidateAccount;
  const signature = JSON.stringify(items);
  if (signature !== listSignature) {
    listSignature = signature;
    list.replaceChildren(...items.map(item => { const { label, input } = optionRow({ type: 'checkbox', value: item.id, checked: selection.has(item.id), title: item.title });
      label.dataset.title = item.title.toLocaleLowerCase();
      input.addEventListener('change', () => { if (input.checked) selection.add(item.id); else selection.delete(item.id); $('collections-error').hidden = true; edited(); });
      return label; }));
    primary.replaceChildren(new Option(t('sites_askPrimary', 'Ask when multiple collections apply'), ''), ...items.map(item => new Option(item.title, item.id)));
    primary.value = items.some(item => item.id === primaryValue) ? primaryValue : '';
    paintFilter();
  }
  $('collection-filter-field').hidden = items.length <= 8;
  const all = items.length > 0 && items.every(item => selection.has(item.id)); button('select-all').hidden = items.length < 2;
  button('select-all').textContent = all ? t('sites_clearAll', 'Clear all') : t('common_selectAll', 'Select all');
  button('read-catalog').disabled = !!c?.reading || !connected;
  const chosen = chosenIds().length;
  text('catalog-summary', !features.collections ? items.length ? t('sites_chosenOf', '$1 of $2 chosen', chosen, items.length) : t('sites_observedCatalogHint', 'Only collections observed in the current source session are shown. Refresh after observing more collections.')
    : c?.reading ? items.length ? tn('sites_readingSoFar', items.length, 'Reading your collections… $1 so far.', 'Reading your collections… $1 so far.') : t('sites_readingCollections', 'Reading your collections…')
    : items.length && c?.nextCursor ? tn('sites_collectionsReadMore', items.length, '$1 collection read; more are available.', '$1 collections read; more are available.')
    : items.length ? t('sites_chosenOf', '$1 of $2 chosen', chosen, items.length)
    : chosen ? tn('sites_chosenCount', chosen, '$1 collection chosen.', '$1 collections chosen.') : t('sites_notReadYet', 'Not read yet.'));
  $('collections-empty').hidden = items.length > 0;
  text('collections-empty-text', !connected ? t('sites_connectToList', 'Connect your account to list your collections.')
    : c?.reading ? t('sites_readingCollections', 'Reading your collections…')
    : c?.failed ? c.failed === 'signedOut' ? errorCopy('signedOut') : t('sites_collectionsUnreadable', 'Couldn’t read your collections. Try again with the refresh button above.')
    : !docs ? t('sites_openToList', 'Open $1 in a tab to list your collections.', site)
    : c?.current && !c.nextCursor ? t('sites_noCollections', 'You have no collections on $1 yet.', site)
    : t('sites_collectionsAppearHere', 'Your collections appear here once Know-N reads them.'));
  button('open-site-list').hidden = !connected || docs > 0;
}
function paintFilter() {
  const needle = filter.value.trim().toLocaleLowerCase();
  for (const row of Array.from(list.children) as HTMLElement[]) row.hidden = !!needle && !row.dataset.title!.includes(needle);
}
filter.addEventListener('input', paintFilter);
button('select-all').addEventListener('click', () => {
  const rows = (Array.from(list.querySelectorAll<HTMLInputElement>('input')));
  const shown = rows.filter(input => !input.closest<HTMLElement>('.option-row')!.hidden), on = !shown.every(input => input.checked);
  for (const input of shown) { input.checked = on; if (on) selection.add(input.value); else selection.delete(input.value); }
  $('collections-error').hidden = true; edited(); paintCollections();
});
// Collections are read on their own once the account is connected and a tab is open, page after page; the refresh button reads them again.
let autoRead = false, wasConnected = false;
const followed = new Set<string>();
// A page that never got a read slot is tried again from the next status.
function readCatalog(cursor: string | null) {
  void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'collections', ...(cursor ? { cursor } : {}) }, undefined, () => {
    if (cursor) followed.delete(cursor); else autoRead = false;
    refreshTimer = setTimeout(() => { void refresh(); }, 3000);
  });
}
function autoCatalog() {
  const connected = !!status.connected && !status.candidateAccount;
  if (connected && !wasConnected) autoRead = false; wasConnected = connected;
  const c = status.catalog;
  if (!features.collections || !connected || !status.documents || c?.reading || c?.failed || currentRoute().view !== 'site') return;
  if (!c?.current) { if (!autoRead) { autoRead = true; readCatalog(null); } return; }
  if (c.nextCursor && !followed.has(c.nextCursor)) { followed.add(c.nextCursor); readCatalog(c.nextCursor); }
}
button('read-catalog').addEventListener('click', () => { followed.clear(); readCatalog(null); });

async function loadRoots() {
  const allowed = await chrome.permissions.contains({ permissions: ['bookmarks'] });
  offer(button('grant-archive'), !allowed && features.archive);
  text('archive-root-hint', allowed ? t('sites_saveIntoHint', 'Each collection becomes a folder inside this one.') : t('sites_allowToChoose', 'Allow bookmark access to choose a folder.'));
  if (!allowed || !features.archive) { picker?.element.remove(); picker = null; paintForm(); return; }
  const choices = folderChoices(await chrome.bookmarks.getTree(), { exclude: await exclusionIds().catch(() => new Set<string>()) });
  if (!picker) {
    picker = createFolderPicker({ choices, value: formRoot, label: t('sites_saveInto', 'Save into'), startEmpty: true,
      onChange: () => { formRoot = picker!.value(); $('root-error').hidden = true; edited(); } });
    picker.pill.id = 'archive-root'; picker.element.id = 'archive-root-picker';
    $('archive-root-slot').prepend(picker.element);
  } else picker.setChoices(choices);
  paintForm();
}
button('grant-archive').addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(granted => { if (granted) return loadRoots(); }); });
// No folder yet: one press makes a folder named after the site, or picks the one already there.
button('create-root').addEventListener('click', () => { void (async () => {
  const tops = (await chrome.bookmarks.getTree())[0]?.children ?? [];
  const parent = tops.find(n => (n as { folderType?: string }).folderType === 'other') ?? tops[1] ?? tops[0]; if (!parent) return;
  const existing = (await chrome.bookmarks.getChildren(parent.id)).find(n => !n.url && n.title === site);
  const folder = existing ?? await chrome.bookmarks.create({ parentId: parent.id, title: site });
  formRoot = folder.id; await loadRoots(); picker?.setValue(folder.id); $('root-error').hidden = true; edited();
})().catch(() => { showToast(t('sites_folderNotCreated', 'Couldn’t make the folder. Choose one instead.'), 'error', { announce: true }); }); });

function paintForm() {
  const config = status.archive?.config ?? null, active = config?.state === 'active', connected = !!status.connected && !status.candidateAccount;
  const configure = button('configure-archive');
  configure.textContent = !config || config.state === 'pending' ? t('sites_startSyncing', 'Start syncing') : config.state === 'disabled' ? t('sites_resumeSyncing', 'Resume syncing') : t('sites_saveChanges', 'Save changes');
  configure.className = active ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  offer(configure, features.archive && connected && (!active || dirty || !!status.archiveHold));
  configure.disabled = configure.hidden || !!status.catalog?.reading;
  offer(button('disable-archive'), active);
  button('create-root').hidden = !picker || !!rootValue();
  const rootName = picker?.pill.querySelector('.folder-pill-name')?.textContent || t('sites_theChosenRoot', 'the chosen root');
  text('archive-summary', dirty && config ? t('sites_unsavedChanges', 'You have changes to save.')
    : !config ? t('sites_notSyncing', 'Not syncing yet.')
    : config.state === 'active' ? tn('sites_syncingInto', config.collectionIds.length, 'Syncing $1 collection into $2.', 'Syncing $1 collections into $2.', rootName)
    : config.state === 'pending' ? t('sites_archivePending', 'Saved. Waiting for the archive root.') : t('sites_syncingPaused', 'Syncing is paused.'));
}
button('configure-archive').addEventListener('click', () => {
  const ids = chosenIds(), root = rootValue();
  $('collections-error').hidden = ids.length > 0; $('root-error').hidden = !!root;
  if (!ids.length || !root) return;
  if (!status.documents) { showToast(errorCopy('pageUnavailable'), 'error', { announce: true }); return; }
  const config = status.archive?.config, job = status.archive?.import, first = config?.state !== 'active';
  button('configure-archive').disabled = true;
  void (async () => {
    const saved = await act({ kind: 'known.siteAdapters.archive.configure', rootNativeId: root, collectionIds: ids, copies: copies.value,
      primarySourceCollectionId: ids.includes(primaryValue) ? primaryValue : null, aiDestination: switchOn('archive-ai') ? 'allowed' : 'excluded',
      semantic: copies.value === 'sourceAndSemantic' && switchOn('archive-semantic') ? 'automatic' : 'manual',
      live: features.liveArchive && switchOn('archive-live') }, () => { dirty = false; });
    if (!saved) { paintForm(); return; }
    showToast(tn('sites_syncingInto', ids.length, 'Syncing $1 collection into $2.', 'Syncing $1 collections into $2.', picker?.pill.querySelector('.folder-pill-name')?.textContent ?? ''), 'ok');
    // Starting to sync also looks for what is already there; that list waits for approval before anything is added.
    // An archive on hold (a restored one not yet rebound) brings nothing in.
    if (first && features.import && !status.archiveHold && (!job || ['cancelled', 'completed'].includes(job.phase))) await act({ kind: 'known.siteAdapters.import.start' });
  })();
});
button('disable-archive').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.archive.disable' }); });

// ---- Step 3: bring in what is already in the collections
let lastImport: ImportStatus | null = null;
const autoFrozen = new Set<string>();
function stoppedCopy(job: ImportStatus) {
  const found = tn('sites_foundSoFar', job.edgeCount, 'Found $1 favorite.', 'Found $1 favorites.');
  switch (job.reason) {
    case 'restartRequired': case 'pageUnavailable': case 'navigationChanged': return t('sites_stoppedTab', 'The $1 tab closed or moved to another page. $2', site, found);
    case 'rateLimited': return t('sites_stoppedRate', '$1 asked Know-N to slow down. Try again in a few minutes. $2', site, found);
    case 'signedOut': return t('sites_stoppedSignedOut', 'You’re signed out of $1. Sign in, then try again. $2', site, found);
    default: return t('sites_stoppedEarly', 'Reading stopped before the end. $1', found);
  }
}
function paintImport(job: ImportStatus | null) {
  const p = job?.preview, c = p?.counts, waiting = !!job && ['preview', 'attention'].includes(job.phase) && !!p, nothing = !!c && !c.createBookmarks && !c.createFolders;
  const scanDone = job?.phase === 'paused' && job.reason === 'scanFinished';
  text('import-state', !job ? t('sites_nothingImported', 'Nothing brought in yet')
    : job.phase === 'scanning' ? t('sites_readingFavorites', 'Reading your favorites…')
    : job.phase === 'preparing' || scanDone ? t('sites_preparingList', 'Making the list…')
    : job.phase === 'paused' ? t('sites_readingStopped', 'Reading stopped early')
    : job.phase === 'preview' ? nothing ? t('sites_nothingNew', 'Nothing new to add') : tn('sites_readyToAdd', c!.createBookmarks, 'Ready to add $1 bookmark', 'Ready to add $1 bookmarks')
    : job.phase === 'attention' ? t('sites_phaseAttention', 'Needs review')
    : job.phase === 'approved' ? job.reason === 'sourceSyncPending' ? t('sites_waitingForBookmarkSync', 'Waiting for bookmark sync…') : t('sites_addingBookmarks', 'Adding bookmarks…')
    : job.phase === 'cancelled' ? t('sites_phaseCancelled', 'Import cancelled') : t('sites_importDone', 'Existing favorites are in'));
  text('import-summary', !job ? t('sites_checkExistingHint', 'Look for favorites saved before syncing started. You see the list before anything is added.')
    : job.phase === 'scanning' ? tn('sites_scanningFound', job.edgeCount, 'Found $1 favorite so far. Nothing is added until you approve the list.', 'Found $1 favorites so far. Nothing is added until you approve the list.')
    : job.phase === 'preparing' || scanDone ? tn('sites_preparingFound', job.edgeCount, 'Found $1 favorite.', 'Found $1 favorites.')
    : job.phase === 'paused' ? stoppedCopy(job)
    : waiting ? [...c!.createFolders ? [tn('sites_listFolders', c!.createFolders, '$1 new folder', '$1 new folders')] : [],
      ...c!.reuseBookmarks ? [tn('sites_listSaved', c!.reuseBookmarks, '$1 already saved', '$1 already saved')] : [],
      ...job.omissions ? [tn('sites_listUnreadable', job.omissions, '$1 couldn’t be read', '$1 couldn’t be read')] : [],
      ...p!.coverage !== 'complete' ? [t('sites_listPartial', 'some collections weren’t read to the end')] : []].join(' · ') || t('sites_listNoChanges', 'Nothing else changes.')
    : job.phase === 'approved' ? job.reason === 'sourceSyncPending' ? t('sites_waitingForBookmarkSyncHint', 'Your approved import is kept. It will continue when the sync connection and folder are ready.') : t('sites_addingInto', 'Adding them to your folder. You can leave this page.')
    : job.phase === 'cancelled' ? t('sites_cancelledHint', 'Nothing more was added.')
    : c ? tn('sites_addedCount', c.createBookmarks, 'Added $1 bookmark. New favorites keep syncing.', 'Added $1 bookmarks. New favorites keep syncing.') : t('sites_doneHint', 'New favorites keep syncing.'));
  const badge = $('import-badge'); badge.hidden = !waiting || !c?.review;
  if (c?.review) { badge.textContent = tn('sites_toReview', c.review, '$1 to review', '$1 to review'); badge.dataset.tone = 'warning'; }
  $('import-progress').hidden = !job || !(['scanning', 'preparing', 'approved'].includes(job.phase) || scanDone);
  const samples = p?.omissions?.samples ?? [], omissions = $<HTMLDetailsElement>('import-omissions');
  omissions.hidden = !waiting || !samples.length;
  $('import-omission-list').replaceChildren(...samples.map(o => { const li = document.createElement('li'); li.textContent = o.reason; li.title = o.id; return li; }));
  const config = status.archive?.config;
  offer(button('start-import'), features.import && config?.state === 'active' && (!job || ['cancelled', 'completed'].includes(job.phase)));
  button('start-import').textContent = job ? t('sites_checkAgain', 'Check again') : t('sites_checkExisting', 'Check for existing favorites');
  offer(button('resume-import'), job?.phase === 'paused' && !scanDone);
  offer(button('freeze-import'), !!job && (job.phase === 'paused' && !scanDone || waiting || job.phase === 'scanning'));
  button('freeze-import').textContent = waiting ? t('sites_makeListAgain', 'Make the list again') : job?.phase === 'scanning' ? t('sites_stopAndReview', 'Stop and review') : t('sites_reviewFound', 'Review what was found');
  button('freeze-import').className = job?.phase === 'paused' ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm';
  offer(button('approve-import'), job?.phase === 'preview' && !!p);
  button('approve-import').textContent = nothing ? t('sites_finish', 'Finish') : tn('sites_addBookmarks', c?.createBookmarks ?? 0, 'Add $1 bookmark', 'Add $1 bookmarks');
  const selectedChanges = reconcileSelections().filter(d => d.choice !== 'keep').length;
  if (selectedChanges) button('approve-import').textContent = t('sites_reconcileApprove', 'Approve saving and $1 chosen changes', selectedChanges);
  offer(button('cancel-import'), !!job && !['cancelled', 'completed'].includes(job.phase));
  // A finished scan becomes its list on its own; the list still waits for approval.
  if (job && scanDone && !autoFrozen.has(`${job.id}:${job.edgeCount}:${job.pages}`)) { autoFrozen.add(`${job.id}:${job.edgeCount}:${job.pages}`); void act({ kind: 'known.siteAdapters.import.freeze', jobId: job.id }); }
}
button('start-import').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.import.start' }); });
button('freeze-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.freeze', jobId: lastImport.id }); });
button('resume-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.resume', jobId: lastImport.id }); });
button('cancel-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.cancel', jobId: lastImport.id }); });
button('approve-import').addEventListener('click', () => { const job = lastImport, p = job?.preview; if (!job || !p) return; button('approve-import').disabled = true;
  void (async () => {
    const result = await request({ kind: 'known.siteAdapters.import.approve', jobId: job.id, previewId: p.id, revision: p.revision, digest: p.digest });
    // A list that changed under the person is made again, never approved in its place.
    if (result.error === 'previewStale') { showToast(errorCopy('previewStale'), 'info', { announce: true }); await act({ kind: 'known.siteAdapters.import.freeze', jobId: job.id }); return; }
    if (result.error) { showToast(errorCopy(result.error), 'error', { announce: true }); await refresh(); return; }
    apply(result);
    if (status.archive?.reconciliation && !status.archive.reconciliationRun) await act({ kind: 'known.siteAdapters.reconcile.apply',
      importId: job.id, digest: status.archive.reconciliation.digest, decisions: reconcileSelections() });
  })(); });

// ---- Recovery tab: the inspector rows
button('read-item').addEventListener('click', () => { void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'resolve' }); });
button('retry-confirmation').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.retryConfirmation' }); });
button('open-recovery').addEventListener('click', () => { showTab('recovery'); });
function paintInspector() {
  const inspection = status.inspection;
  if (inspection?.command.operation === 'resolveItem' && inspection.result)
    text('item-summary', inspection.result.status !== 'resolved' ? t('sites_noItem', 'No single item was found in the selected source tab.')
      : inspection.result.item?.title ? t('sites_foundItem', 'Found “$1”.', inspection.result.item.title) : t('sites_foundThisItem', 'Found this item.'));
  const waiting = status.confirmations?.pending ?? 0;
  text('confirmation-summary', waiting ? tn('sites_readsWaiting', waiting, '$1 read waiting.', '$1 reads waiting.')
    : status.confirmations?.paused ? t('sites_paused', 'Paused.') : t('sites_noneWaiting', 'None waiting.'));
}
function paintSemantic() {
  const summary = status.archive?.semantic;
  $('semantic-progress').hidden = !summary || !(summary.pending + summary.attention + summary.completed + summary.suppressed);
  if (!summary) return;
  text('semantic-summary', t('sites_semanticSummary', '$1 saved · $2 waiting · $3 need attention', summary.completed, summary.pending, summary.attention));
  $('semantic-jobs').replaceChildren(...summary.jobs.map(job => {
    const row = document.createElement('div'); row.className = 'set-row';
    const body = document.createElement('div'); body.className = 'set-row-text';
    const title = document.createElement('p'); title.className = 'set-row-title'; title.textContent = job.title;
    const hint = document.createElement('p'); hint.className = 'set-row-hint'; hint.textContent = errorCopy(job.reason ?? 'sourceSyncPending'); body.append(title, hint); row.append(body);
    if (job.state === 'attention' || job.takeover) {
      const reclassify = ['semanticChooseFolder', 'semanticDestinationMapped', 'semanticDestinationOutsideLibrary', 'destination_policy_changed'].includes(job.reason ?? '');
      const retry = document.createElement('button'); retry.className = 'btn btn-secondary btn-sm'; retry.type = 'button';
      retry.textContent = job.takeover ? t('sites_semanticTakeover', 'Take over and retry') : reclassify ? t('sites_classifyAgain', 'Classify again') : t('common_retry', 'Retry');
      retry.addEventListener('click', () => { retry.disabled = true; void act({ kind: 'known.siteAdapters.semantic.retry', jobId: job.id, ...(reclassify ? { reclassify: true } : {}) }); }); row.append(retry);
    }
    return row;
  }));
}

const step = (id: string, state: 'current' | 'done' | 'later') => { $(id).dataset.step = state; };
function paint() {
  const config = status.archive?.config ?? null, job = status.archive?.import ?? null, connected = !!status.connected && !status.candidateAccount;
  lastImport = job; loadConfig(config);
  step('step-connect', connected ? 'done' : 'current');
  step('step-choose', config?.state === 'active' ? 'done' : connected || config ? 'current' : 'later');
  step('step-import', config?.state !== 'active' && !job ? 'later' : job?.phase === 'completed' ? 'done' : 'current');
  $('archive-hold').hidden = !status.archiveHold;
  if (status.archiveHold) text('archive-hold', errorCopy(status.archiveHold));
  paintConnection(); paintCollections(); paintForm(); paintInspector(); paintSemantic();
  paintReconciliation(status.archive?.reconciliation, status.archive?.reconciliationRun, job?.phase);
  paintImport(job);
  renderSiteCapabilities(document, selectedSite, !!job, !!config);
  autoCatalog();
}
onRoute(route => { if (route.view === 'site') autoCatalog(); });
void refresh();
void loadRoots();
