import { paintSemanticRecovery, type SemanticStatus } from './settings-semantic.js';
import { siteFeatures } from './capabilities.js';
import { siteGrants } from './community-definition.js';
import { renderSiteCapabilities } from './settings-capabilities.js';
import { selectedSite, sendSiteMessage, SITE_PROBLEM_EVENT, mountSiteNav, paintSiteNav, mountRoutes, onRoute, currentRoute, showTab, offer } from './settings-client.js';
import { createFolderPicker, folderChoices, type FolderPicker } from '../library-folder-picker.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { optionRow } from '../library-dom.js';
import { hydrateIcons } from '../icons.js';
import { localizePage, onUiLanguageChanged, t, tn } from '../i18n.js';
import { showToast } from '../toast.js';
import { createSiteMark } from './site-icon.js';
import './settings-recovery.js';
import './settings-reconcile-history.js';
import './community-settings.js';
import './cloud-settings.js';
import { paintReconciliation, installReconcileControls, reconcileSelections, reconcilePageOffset } from './settings-reconcile.js';
import { paintSiteImport, type ImportStatus } from './settings-import.js';
import { installSiteImportActions } from './settings-import-actions.js';
import { importBlocker } from './import-problems.js';
import { createSettingsRequestOrder } from './settings-request-order.js';
import { createSiteConfiguration } from './settings-configuration.js';
import { createSiteActivityView } from './settings-activity.js';
import { paintSourceOverview } from './settings-overview.js';
import { paintImportReview } from './settings-review.js';
import { siteProblem } from './problem-view.js';
import { siteOperation, sourceActivityCounts, type SiteActivity } from './activity.js';
import type { SourceOverview } from './overview.js';
import type { ReconcilePreview } from './reconcile-model.js';
import type { ReconcileRun } from './reconcile-run.js';
interface Collection { id: string; title: string }
interface ArchiveConfig { root: { nativeId: string }; collectionIds: readonly string[]; live: boolean; state: string; copies?: string; primarySourceCollectionId?: string | null; aiDestination?: string; semantic?: string }
interface SiteStatus { pipeline?: import('./local-progress.js').LocalSourceProgress; inspectionStatus?: { status: string; retryAfterMs?: number }; enabled?: boolean; connected?: boolean; accountId?: string | null; documents?: number; candidateAccount?: string | null; error?: string; incidentId?: string;
  accountLabel?: string; candidateLabel?: string;
  activity?: { problem: SiteActivity | null; lastEvent: SiteActivity | null };
  confirmations?: { pending: number; paused?: unknown }; archiveHold?: string | null;
  browser?: { minimum: number; major: number | null; supported: boolean }; grants?: { site: boolean; bookmarks: boolean; userScripts?: boolean };
  catalog?: { items: Collection[]; nextCursor: string | null; reading: boolean; current: boolean; failed: string | null } | null;
  inspection?: { command: { deadlineAt: number; operation?: string }; result?: { status: string; item?: { title?: string } } } | null;
  archive?: { catalog?: Collection[]; config: ArchiveConfig | null; import: ImportStatus | null; overview?: SourceOverview | null; overviewError?: string | null;
    semantic?: SemanticStatus | null; reconciliation?: ReconcilePreview | null; reconciliationRun?: ReconcileRun | null } }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const button = (id: string) => $<HTMLButtonElement>(id);
const text = (id: string, value: string) => { $(id).textContent = value; };
// Static copy is marked data-i18n; the lines that name the site are filled here. A language change reloads the page, as the options page does.
localizePage(); onUiLanguageChanged(() => location.reload());
hydrateIcons(document); mountSiteNav(); mountRoutes();
const site = selectedSite.label, features = siteFeatures(selectedSite);
text('site-title', site);
const siteTitle = $('site-title');
siteTitle.before(createSiteMark({ label: site, origin: selectedSite.origin, icon: selectedSite.icon, size: 40, className: 'sites-mark sites-mark--page' }));
siteTitle.parentElement!.classList.add('sites-page-head');
text('sites-lede', t('sites_ledeSync', 'Keep your $1 favorites as bookmarks in this browser.', site));
text('archive-live-hint', t('sites_keepSyncingHint', 'Favorites you add on $1 are saved here as you add them.', site));
for (const id of ['open-site-label', 'open-site-list-label']) text(id, t('sites_openSite', 'Open $1', site));
text('create-root-label', t('sites_newFolderNamed', 'New folder “$1”', site));
renderSiteCapabilities(document, selectedSite);
// The legacy COLP Server archive needs a server-side identity codec, which an installed package does not have.
$('tab-cloud').hidden = selectedSite.runtime === 'userScript';
// Back to the settings pane the page was opened from.
if (document.referrer.startsWith(new URL('options.html', location.href).href)) $<HTMLAnchorElement>('sites-back').href = document.referrer;

/** Words for a worker code. A code never appears in a sentence; the full reply is in Recovery › Technical details. */
function errorCopy(code: string | undefined) {
  switch (code) {
    case 'permissionRequired': return t('sites_accessRequired', 'Know-N needs access first. Allow it, then try again.');
    case 'communityToggleRequired': return t('sites_userScriptsToggle', 'Turn on Allow User Scripts for Know-N in Extensions → Details, reload the extension, then try again.');
    case 'browserUnsupported': return t('sites_newerChrome', 'Site adapters need a newer version of Chrome.');
    case 'refreshCatalogRequired': case 'staleCursor': return t('sites_collectionsChanged', 'Your collections changed. Check the list, then try again.');
    case 'bindingUnavailable': return t('sites_folderGone', 'That folder is gone. Choose another one.');
    case 'invalidPrimaryCollection': return t('sites_primaryNotChosen', 'The primary collection must be one of the collections you chose.');
    case 'chooseArchiveRoot': return t('sites_chooseFolder', 'Choose a folder.');
    case 'invalidScope': return t('sites_chooseCollectionsFirst', 'Choose at least one source collection before saving these settings.');
    case 'importAlreadyActive': return t('sites_importRunning', 'An import is already running.');
    case 'previewStale': return t('sites_previewChanged', 'The save plan is out of date. Choose Prepare import again to update it using the items already read.');
    case 'signedOut': return t('sites_signedOut', 'You’re signed out of $1. Sign in there, then try again.', site);
    case 'rateLimited': return t('sites_rateLimited', '$1 asked Know-N to slow down. Try again in a few minutes.', site);
    case 'ruleRejected': return t('sites_ruleRejected', 'This browser’s rules couldn’t take the archive rule. Check Automations, then try again.');
    case 'sourceAutomationPaused': return t('sites_automationsPaused', 'Automations are paused in this browser. Resume them, then try again.');
    case 'sourceNeedsReview': return t('sites_mappingNeedsReview', 'This mapping needs to be checked before saving can continue. Open Recovery to review it.');
    case 'sourceCloudUnsupported': return t('sites_refreshSyncedPreview', 'This folder now participates in sync. Make the import preview again before saving.');
    case 'sourceSyncUpgradeRequired': return t('sites_syncServerUpgrade', 'Update COLP Server to support saving website collections into synced folders.');
    case 'sourceDestinationChanged': return t('sites_destinationChanged', 'The sync account or folder range changed. Check this folder and save the settings again.');
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
    case 'sourceSyncRecovering': return t('sites_waitingForSyncRecovery', 'Bookmark sync is recovering');
    case 'sourceCopySuppressed': return t('sites_semanticSuppressed', 'This copy was deleted. It will stay deleted.');
    case 'sourceCopyDetached': case 'semanticBindingNeedsReview': return t('sites_semanticReview', 'This copy was changed or its old association needs review. Existing bookmarks are kept.');
    case 'semanticPaused': return t('sites_semanticPaused', 'Paused because the source account or settings changed.');
    default: { const problem = siteProblem(code ?? 'unavailable', site); return `${problem.what} ${problem.next}`; }
  }
}
/** One notice at the top of the page, for what blocks the whole site; a step's own result is a toast. */
function showAlert(message: string | null) { text('site-alert-text', message ?? ''); $('site-alert').hidden = !message; }
function statusAlert(s: SiteStatus) {
  if (s.error) return ['browserUnsupported', 'permissionRequired', 'communityToggleRequired'].includes(s.error) ? errorCopy(s.error) : t('sites_statusUnreadable', 'Couldn’t read the current sync status. Try again, or open Recovery for details.');
  if (!s.browser || s.browser.supported) return null;
  return s.browser.major ? t('sites_chromeVersion', 'Site adapters need Chrome $1 or later; this is Chrome $2.', s.browser.minimum, s.browser.major)
    : t('sites_chromeMinimum', 'Site adapters need Chrome $1 or later.', s.browser.minimum);
}

let status: SiteStatus = {};
let statusReady = false, statusError: string | undefined, statusFailures = 0;
const requestOrder = createSettingsRequestOrder(), responseOrder = new WeakMap<object, () => boolean>();
const activityView = createSiteActivityView(message => sendSiteMessage(message), selectedSite);
const problemEvent = (event: Event) => { const detail = (event as CustomEvent<{ kind: string; error: string; incidentId?: string }>).detail;
  showActionProblem(detail, detail.kind); };
document.addEventListener(SITE_PROBLEM_EVENT, problemEvent);
const configuration = createSiteConfiguration(() => { dirty = false; configSignature = undefined; activityView.discardConfiguration(); loadConfig(status.archive?.config ?? null); paint(); });
button('site-configure').addEventListener('click', () => { showTab('sync'); configuration.open(); });
button('overview-manage-connection').addEventListener('click', () => configuration.open('connection'));
button('overview-edit-destination').addEventListener('click', () => configuration.open('destination'));
button('overview-manage-collections').addEventListener('click', () => configuration.open('collections'));
button('overview-identify').addEventListener('click', () => { void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'resolve' }); });
document.querySelector('#site-problem .sites-problem-actions')!.append(button('retry-site-status'));
let disposed = false;
installReconcileControls(message => act(message), () => { if (lastImport) paintImport(lastImport); });
let lastActionError: { operation: string; error: string; at: number } | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined, inspectionRetry: ReturnType<typeof setTimeout> | undefined;
function completeStatus(result: SiteStatus) {
  return typeof result.enabled === 'boolean' && typeof result.connected === 'boolean' && Number.isSafeInteger(result.documents);
}
/** The worker answers with the full status; a message nothing answers comes back as a refusal, never as silence. */
async function request(message: unknown, current = requestOrder.read()): Promise<SiteStatus> {
  let result: SiteStatus;
  try {
    const reply: unknown = await sendSiteMessage(message, { reportErrors: false });
    result = reply && typeof reply === 'object' && !Array.isArray(reply) ? reply as SiteStatus : { error: 'unavailable' };
  } catch { result = { error: 'unavailable' }; }
  if ((message as { kind?: string }).kind === 'known.siteAdapters.status' && !result.error && !completeStatus(result)) result = { error: 'unavailable' };
  responseOrder.set(result, current); return result;
}
async function refresh() { if (disposed) return status; clearTimeout(refreshTimer);
  const result = await request({ kind: 'known.siteAdapters.status', reconcileOffset: reconcilePageOffset() });
  if (responseOrder.get(result)?.() && !result.error) activityView.succeeded('status'); return apply(result); }
/** Run a step. Refusals remain in the operation record while status is refreshed. */
async function act(message: unknown, done?: () => void): Promise<boolean> {
  if (!statusReady || disposed) return false;
  const action = message as { kind: string }, ticket = requestOrder.action(action.kind);
  if (!ticket) return false;
  clearTimeout(refreshTimer); paint(); configuration.pending(true);
  let failed = false;
  try {
    const result = await request(message, ticket.current);
    if (result.error) {
      failed = true; lastActionError = { operation: action.kind, error: result.error, at: Date.now() };
      showActionProblem(result, action.kind); showToast(errorCopy(result.error), 'error', { announce: true }); return false;
    }
    if (lastActionError?.operation === action.kind) lastActionError = undefined;
    activityView.succeeded(siteOperation(action.kind)); done?.();
    // Recovery and cloud operations acknowledge completion without returning site state.
    // Keep the current view until a fresh status arrives under this action's ordering fence.
    apply(completeStatus(result) ? result : await request({ kind: 'known.siteAdapters.status', reconcileOffset: reconcilePageOffset() }, ticket.current));
    activityView.changed(); return true;
  } finally {
    ticket.finish(); configuration.pending(false);
    if (!disposed) { paint(); if (failed) await refresh(); }
  }
}
function showActionProblem(result: SiteStatus, kind: string) {
  const job = status.archive?.import;
  activityView.failed(result.error ?? 'unavailable', result.incidentId,
    job ? sourceActivityCounts(job) : undefined, siteOperation(kind));
}
function apply(result: SiteStatus) {
  if (disposed || responseOrder.get(result)?.() === false) return result;
  clearTimeout(refreshTimer);
  $('status').textContent = JSON.stringify({ ...result, ...(lastActionError ? { lastActionError } : {}) }, null, 2);
  showAlert(statusAlert(result)); paintSiteNav(selectedSite.adapterId, result);
  button('retry-site-status').hidden = !result.error;
  statusReady = !result.error; statusError = result.error;
  if (result.error) {
    statusFailures = Math.min(5, statusFailures + 1); paint();
    showActionProblem(result, 'known.siteAdapters.status');
    schedule(); return result;
  }
  statusFailures = 0;
  activityView.paint(result.activity?.problem);
  if (result.archive?.import?.authorization === 'current' && ['preparing', 'preview'].includes(result.archive.import.phase)) activityView.succeeded('read');
  status = result; paint(); schedule(); return result;
}
/** Poll while something moves (a scan, a read, a confirmation) or while waiting for a tab or an account. */
function schedule() {
  clearTimeout(refreshTimer);
  if (disposed || document.visibilityState === 'hidden') return;
  if (statusError) { refreshTimer = setTimeout(() => { void refresh(); }, Math.min(30000, 3000 * 2 ** (statusFailures - 1))); return; }
  const job = status.archive?.import;
  const busy = job && ['scanning', 'preparing', 'approved'].includes(job.phase) || !!status.confirmations?.pending || !!status.catalog?.reading
    || !!status.inspection && !status.inspection.result && status.inspection.command.deadlineAt > Date.now() || !!status.archive?.semantic?.pending
    || !!status.archive?.reconciliationRun?.progress?.pending || !!status.archive?.reconciliationRun?.operations.some(op => op.state === 'pending');
  const waiting = !!status.enabled && (!status.connected || !status.documents);
  if (busy || waiting || status.archive?.config) refreshTimer = setTimeout(() => { if (document.visibilityState === 'visible') void refresh(); }, busy ? 500 : waiting ? 2000 : 5000);
}
const visibilityChanged = () => { clearTimeout(refreshTimer); if (document.visibilityState === 'visible') void refresh(); };
document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(refreshTimer); clearTimeout(inspectionRetry);
  document.removeEventListener('visibilitychange', visibilityChanged); document.removeEventListener(SITE_PROBLEM_EVENT, problemEvent); }, { once: true });
/** Ask for a read, waiting out a busy read slot for up to 30 seconds; `gaveUp` runs if it never started. */
async function requestInspection(message: unknown, until = Date.now() + 30000, gaveUp?: () => void) {
  if (!statusReady || disposed) { gaveUp?.(); return; }
  clearTimeout(inspectionRetry);
  const result = await request(message);
  if (!responseOrder.get(result)?.()) { gaveUp?.(); return; }
  if (result.error) { showActionProblem(result, 'known.siteAdapters.inspect'); await refresh(); return; }
  apply(result);
  if (result.inspectionStatus?.status !== 'paused') return;
  if (Date.now() < until) inspectionRetry = setTimeout(() => { void requestInspection(message, until, gaveUp); }, Math.max(500, result.inspectionStatus.retryAfterMs ?? 1500));
  else gaveUp?.();
}
const openSite = () => { void chrome.tabs.create({ url: selectedSite.origin }); };
for (const id of ['open-site', 'open-site-list']) button(id).addEventListener('click', openSite);

// ---- Step 1: connect
function paintConnection() {
  if (selectedSite.connectionKind !== 'page') text('sites-connection-heading', status.archive?.config ? t('sites_accountAndAccess', 'Account and access') : t('sites_stepConnect', 'Connect your account'));
  if (!statusReady) {
    text('connection-title', t('sites_checkingSourceConnection', 'Checking the $1 connection…', site));
    text('connection', statusError ? statusAlert({ error: statusError })! : '');
    for (const id of ['enable', 'confirm', 'disable', 'open-site', 'account-value']) $(id).hidden = true;
    return;
  }
  const s = status, enabled = !!s.enabled, granted = s.grants?.site ?? false, candidate = s.candidateAccount ?? null, connected = !!s.connected && !candidate, docs = s.documents ?? 0;
  // An installed package also needs Chrome's Allow User Scripts, which only the person can turn on.
  const userScriptsOff = enabled && granted && s.grants?.userScripts === false;
  const title = !enabled ? t('sites_turnOnSite', 'Turn on $1', site) : !granted ? t('sites_needsAccess', '$1 needs site access', site)
    : userScriptsOff ? t('sites_userScriptsOff', 'Allow user scripts for Know-N')
    : candidate ? s.candidateLabel ? t('sites_signedInAs', 'Signed in to $1 as $2', site, s.candidateLabel) : t('sites_confirmDetectedAccount', 'Confirm the account detected on $1', site)
    : connected ? s.accountLabel ? t('sites_accountDisplayName', '$1 · $2', site, s.accountLabel) : t('sites_connected', 'Connected')
    : t('sites_openAndSignIn', 'Open $1 and sign in', site);
  const hint = !enabled ? t('sites_turnOnHint', 'Know-N reads your favorites from the $1 tabs you open. It never changes anything on $1.', site)
    : !granted ? t('sites_needsAccessHint', 'Allow access to $1 so Know-N can read your favorites.', new URL(selectedSite.origin).hostname)
    : userScriptsOff ? t('sites_userScriptsOffHint', '$1 runs as an installed package. In Extensions → Know-N → Details, turn on Allow User Scripts, reload the extension, then reopen this page.', site)
    : candidate ? t('sites_connectHint', 'Connect this account to sync its collections.')
    : connected ? docs ? tn('sites_availableTabs', docs, '$1 open $2 tab available.', '$1 open $2 tabs available.', site) : t('sites_noReadablePage', 'No $1 page is connected for reading. Open or reload the website when you want to check its content.', site)
    : t('sites_openSignedInHint', 'Know-N finds your account in an open $1 tab.', site);
  text('connection-title', title); text('connection', hint);
  $('account-value').hidden = !connected;
  const enable = button('enable'); enable.textContent = enabled && !granted ? t('sites_allowAccess', 'Allow access') : t('sites_turnOn', 'Turn on');
  enable.hidden = enabled && granted; enable.disabled = !!s.browser && !s.browser.supported;
  button('confirm').hidden = !candidate; button('disable').hidden = !enabled;
  button('open-site').hidden = !enabled || !granted || userScriptsOff || !!candidate || connected && docs > 0;
  // An extra tab to open is secondary to connecting the account.
  button('open-site').className = !connected ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
  if (selectedSite.connectionKind === 'page') {
    text('sites-connection-heading', t('sites_connectWebsite', 'Connect the website'));
    text('connection-title', connected ? t('sites_websiteConnected', 'Website connected') : t('sites_openSite', 'Open $1', site));
    text('connection', t('sites_pageConnectionHint', 'This source uses the current website page. No account connection is needed.'));
    $('account-value').hidden = true; button('confirm').hidden = true;
  }
}
button('enable').addEventListener('click', () => {
  if (!statusReady) return;
  void chrome.permissions.request(siteGrants(selectedSite)).then(granted => {
    if (granted) return act({ kind: 'known.siteAdapters.enable', enabled: true }); showToast(t('sites_siteAccessRequired', 'Site access is required.'), 'error', { announce: true });
  }).catch(() => { showToast(t('sites_siteAccessUnavailable', 'Site access is unavailable.'), 'error', { announce: true }); });
});
button('disable').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.enable', enabled: false }); });
button('confirm').addEventListener('click', () => { const account = status.candidateAccount; if (account) void act({ kind: 'known.siteAdapters.confirm', accountId: account }); });
button('refresh').addEventListener('click', () => { void refresh(); });
button('retry-site-status').addEventListener('click', () => { void refresh(); });

// ---- Step 2: choose collections and a folder
const selection = new Set<string>();
let formRoot = '', primaryValue = '', dirty = false, configSignature: string | undefined, listSignature: string | undefined;
let picker: FolderPicker | null = null;
let folderNames = new Map<string, string>();
let folderPaths = new Map<string, string>();
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
const chosenIds = () => [...selection];
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
  if (selectedSite.defaultCollection) selection.add(selectedSite.defaultCollection.id);
  const items = catalogItems(), c = status.catalog, docs = status.documents ?? 0, connected = !!status.connected && !status.candidateAccount;
  const signature = JSON.stringify(items);
  if (signature !== listSignature) {
    listSignature = signature;
    list.replaceChildren(...items.map(item => { const { label, input } = optionRow({ type: 'checkbox', value: item.id, checked: selection.has(item.id), title: item.title });
      input.disabled = !!selectedSite.defaultCollection;
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
  text('catalog-summary', selectedSite.defaultCollection ? t('sites_singleListHint', 'This source provides one list.') : !features.collections ? items.length ? t('sites_chosenOf', '$1 of $2 chosen', chosen, items.length) : t('sites_observedCatalogHint', 'Only collections observed in the current source session are shown. Refresh after observing more collections.')
    : c?.reading ? items.length ? tn('sites_readingSoFar', items.length, 'Reading your collections… $1 so far.', 'Reading your collections… $1 so far.') : t('sites_readingCollections', 'Reading your collections…')
    : items.length && c?.nextCursor ? tn('sites_collectionsReadMore', items.length, '$1 collection read; more are available.', '$1 collections read; more are available.')
    : items.length && chosen <= items.length ? t('sites_chosenOf', '$1 of $2 chosen', chosen, items.length)
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
  if (requestOrder.pending || !features.collections || !connected || !status.documents || c?.reading || c?.failed || currentRoute().view !== 'site') return;
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
  folderNames = new Map(choices.map(choice => [choice.id, choice.title]));
  folderPaths = new Map(choices.map(choice => [choice.id, choice.path.join(' / ')]));
  if (!picker) {
    picker = createFolderPicker({ choices, value: formRoot, label: t('sites_saveInto', 'Save into'), startEmpty: true,
      onChange: () => { formRoot = picker!.value(); $('root-error').hidden = true; edited(); } });
    picker.pill.id = 'archive-root'; picker.element.id = 'archive-root-picker';
    $('archive-root-slot').prepend(picker.element);
  } else picker.setChoices(choices);
  paintForm();
  if (status.archive?.config) paintSourceOverview(status, selectedSite, folderNames, (part, collectionId) => configuration.open(part, collectionId), folderPaths);
}
button('grant-archive').addEventListener('click', () => { void chrome.permissions.request({ permissions: ['bookmarks'] }).then(granted => { if (granted) return loadRoots(); }); });
// No folder yet: one press makes a folder named after the site, or picks the one already there.
button('create-root').addEventListener('click', () => { void (async () => {
  const tops = (await chrome.bookmarks.getTree())[0]?.children ?? [];
  const parent = tops.find(n => (n as { folderType?: string }).folderType === 'other') ?? tops[1] ?? tops[0]; if (!parent) return;
  const existing = (await chrome.bookmarks.getChildren(parent.id)).find(n => !n.url && n.title === site);
  const folder = existing ?? await chrome.bookmarks.create({ parentId: parent.id, title: site });
  formRoot = folder.id; await loadRoots(); picker?.setValue(folder.id); $('root-error').hidden = true; edited();
})().catch(() => { showActionProblem({ error: 'folderCreateFailed' }, 'known.siteAdapters.archive.configure'); }); });

function paintForm() {
  const config = status.archive?.config ?? null, active = config?.state === 'active', connected = !!status.connected && !status.candidateAccount;
  const configure = button('configure-archive');
  configure.textContent = importBlocker(status.archive?.import ?? null) ? t('sites_confirmSaveLocation', 'Confirm save location') : !config || config.state === 'pending' ? features.import ? t('sites_readAndPreview', 'Read and preview') : t('sites_saveSettings', 'Save settings') : config.state === 'disabled' ? t('sites_resumeSyncing', 'Resume syncing') : t('sites_saveChanges', 'Save changes');
  configure.className = 'btn btn-primary btn-sm';
  offer(configure, features.archive && connected);
  const needsCatalog = !config || chosenIds().some(id => !config.collectionIds.includes(id));
  configure.disabled = configure.hidden || !!status.catalog?.reading && needsCatalog || active && !dirty && !status.archiveHold && !importBlocker(status.archive?.import ?? null);
  configure.setAttribute('aria-busy', String(requestOrder.pending === 'known.siteAdapters.archive.configure'));
  if (requestOrder.pending) configure.disabled = true;
  if (requestOrder.pending === 'known.siteAdapters.archive.configure') configure.textContent = t('sites_confirmingLocation', 'Confirming save location…');
  offer(button('disable-archive'), active);
  button('create-root').hidden = !picker || !!rootValue();
  const rootName = folderNames.get(config?.root.nativeId ?? '') || t('sites_theChosenRoot', 'the chosen root');
  text('import-destination', config ? tn('sites_importDestination', config.collectionIds.length, '$1 collection → $2', '$1 collections → $2', rootName) : '');
  text('archive-summary', dirty && config ? t('sites_unsavedChanges', 'You have changes to save.')
    : !config ? t('sites_notSyncing', 'Not syncing yet.')
    : config.state === 'active' ? tn('sites_mappedInto', config.collectionIds.length, 'Mapped $1 collection to $2.', 'Mapped $1 collections to $2.', rootName)
    : config.state === 'pending' ? t('sites_archivePending', 'Saved. Waiting for the archive root.') : t('sites_syncingPaused', 'Syncing is paused.'));
}
button('configure-archive').addEventListener('click', () => {
  const ids = chosenIds(), root = rootValue();
  $('collections-error').hidden = ids.length > 0; $('root-error').hidden = !!root;
  if (!ids.length || !root) { showToast(errorCopy(!root ? 'chooseArchiveRoot' : 'invalidScope'), 'error', { announce: true }); return; }
  const config = status.archive?.config, job = status.archive?.import, first = config?.state !== 'active';
  button('configure-archive').disabled = true;
  void (async () => {
    const saved = await act({ kind: 'known.siteAdapters.archive.configure', rootNativeId: root, collectionIds: ids, copies: copies.value,
      primarySourceCollectionId: ids.includes(primaryValue) ? primaryValue : null, aiDestination: switchOn('archive-ai') ? 'allowed' : 'excluded',
      semantic: copies.value === 'sourceAndSemantic' && switchOn('archive-semantic') ? 'automatic' : 'manual',
      live: features.liveArchive && switchOn('archive-live') }, () => { dirty = false; });
    if (!saved) { paintForm(); return; }
    configuration.saved();
    showToast(tn('sites_mappedInto', ids.length, 'Mapped $1 collection to $2.', 'Mapped $1 collections to $2.', picker?.pill.querySelector('.folder-pill-name')?.textContent ?? ''), 'ok');
    // Starting to sync also looks for what is already there; that list waits for approval before anything is added.
    // An archive on hold (a restored one not yet rebound) brings nothing in.
    if (first && features.import && !status.archiveHold && (!job || ['cancelled', 'completed'].includes(job.phase))) await act({ kind: 'known.siteAdapters.import.start' });
  })();
});
button('disable-archive').addEventListener('click', () => { void act({ kind: 'known.siteAdapters.archive.disable' }); });

// ---- Step 3: bring in what is already in the collections
let lastImport: ImportStatus | null = null;
let approvingImport = false, outdatedPreview: string | null = null;
function paintImport(job: ImportStatus | null) {
  paintSiteImport({ job, site, documents: status.documents ?? 0, enabled: !!status.enabled,
    connected: !!status.connected && !status.candidateAccount, bookmarkAccess: status.grants?.bookmarks ?? false, hold: status.archiveHold ?? null,
    config: status.archive?.config ?? null, saved: status.archive?.overview?.saved, lastEvent: status.activity?.lastEvent ?? null,
    problem: status.activity?.problem ?? null, available: features.import, hasDifferences: !!status.archive?.reconciliation, checkingSource: importActions.pending,
    canApplyChanges: reconcileSelections().some(d => d.choice !== 'keep'), approvingImport, pendingAction: requestOrder.pending,
    previewOutdated: !!job?.preview && job.preview.id === outdatedPreview, errorCopy });
  const selectedChanges = reconcileSelections().filter(d => d.choice !== 'keep').length;
  if (selectedChanges) button('approve-import').textContent = t('sites_reconcileApprove', 'Approve saving and $1 chosen changes', selectedChanges);
}
const importActions = installSiteImportActions(selectedSite, { status: () => status, refresh, act, disposed: () => disposed,
  paint: () => paintImport(lastImport), connect: () => configuration.open('connection'),
  failed: (error, kind) => { showActionProblem({ error }, kind); showToast(errorCopy(error), 'error', { announce: true }); } });
button('import-open-recovery').addEventListener('click', () => { showTab('recovery'); });
button('import-review-items').addEventListener('click', () => { $<HTMLDetailsElement>('reconcile-details').open = true; $('reconcile-details').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
button('import-review-settings').addEventListener('click', () => configuration.open(importBlocker(lastImport) ? 'destination' : 'collections'));
button('import-review-check').addEventListener('click', () => { const job = lastImport; if (!job) return;
  const button = document.getElementById('import-review-check')! as HTMLButtonElement; button.disabled = true;
  void (async () => {
    const result = await request({ kind: 'known.siteAdapters.operations.check' });
    if (result.error) { showActionProblem(result, 'known.siteAdapters.operations.check'); await refresh(); }
    else {
      activityView.succeeded('recover');
      if (lastImport?.id === job.id && ['preview', 'attention'].includes(lastImport.phase)) await act({ kind: 'known.siteAdapters.import.freeze', jobId: job.id });
      else await refresh();
    }
  })().finally(() => { button.disabled = false; });
});
button('import-edit-settings').addEventListener('click', () => configuration.open(importBlocker(lastImport) ? 'destination' : 'connection'));
button('freeze-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.freeze', jobId: lastImport.id }); });
button('retry-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.retry', jobId: lastImport.id }); });
button('cancel-import').addEventListener('click', () => { if (lastImport) void act({ kind: 'known.siteAdapters.import.cancel', jobId: lastImport.id }); });
button('approve-import').addEventListener('click', () => { const job = lastImport, p = job?.preview; if (!job || !p || approvingImport) return;
  approvingImport = true; paintImport(job);
  void (async () => {
    const saved = await act({ kind: 'known.siteAdapters.import.approve', jobId: job.id, previewId: p.id, revision: p.revision, digest: p.digest });
    if (!saved) { if (lastActionError?.error === 'previewStale') outdatedPreview = p.id; return; }
    if (status.archive?.reconciliation && !status.archive.reconciliationRun) await act({ kind: 'known.siteAdapters.reconcile.apply',
      importId: job.id, digest: status.archive.reconciliation.digest, decisions: reconcileSelections() });
  })().finally(() => { approvingImport = false; if (!disposed) paintImport(lastImport); }); });

// ---- Recovery tab: the inspector rows
button('read-item').addEventListener('click', () => { void requestInspection({ kind: 'known.siteAdapters.inspect', operation: 'resolve' }); });
document.getElementById('source-pipeline-retry')?.addEventListener('click', () => { void act({ kind: 'known.siteAdapters.operations.check' }); });
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
  paintSemanticRecovery($('semantic-jobs'), summary, message => sendSiteMessage(message), message => act(message), errorCopy);
}

const step = (id: string, state: 'current' | 'done' | 'later') => { $(id).dataset.step = state; };
function paint() {
  paintConnection();
  if (!statusReady) {
    $('source-overview').hidden = true; configuration.unavailable(); button('site-configure').hidden = true;
    for (const id of ['step-import', 'semantic-progress', 'reconcile-details']) $(id).hidden = true;
    activityView.layout(); return;
  }
  const config = status.archive?.config ?? null, job = status.archive?.import ?? null, connected = !!status.connected && !status.candidateAccount;
  lastImport = job; loadConfig(config);
  step('step-connect', connected ? 'done' : 'current');
  step('step-choose', config?.state === 'active' ? 'done' : connected || config ? 'current' : 'later');
  step('step-import', config?.state !== 'active' && !job ? 'later' : job?.phase === 'completed' ? 'done' : 'current');
  $('archive-hold').hidden = !status.archiveHold;
  if (status.archiveHold) text('archive-hold', errorCopy(status.archiveHold));
  paintCollections(); paintForm(); paintInspector(); paintSemantic();
  paintReconciliation(status.archive?.reconciliation, status.archive?.reconciliationRun, job?.phase);
  $('reconcile-details').hidden = !paintImportReview(job, selectedSite, !!status.archive?.reconciliation) && !status.archive?.reconciliation;
  paintImport(job);
  renderSiteCapabilities(document, selectedSite, !!job, !!config);
  configuration.paint(!!config);
  button('site-configure').hidden = !config;
  $('step-import').hidden = !config;
  paintSourceOverview(status, selectedSite, folderNames, (part, collectionId) => configuration.open(part, collectionId), folderPaths);
  activityView.layout();
  autoCatalog();
}
onRoute(route => { if (route.tab !== 'sync') $<HTMLDetailsElement>('site-tools').open = true; if (route.view === 'site') autoCatalog(); });
if (currentRoute().tab !== 'sync') $<HTMLDetailsElement>('site-tools').open = true;
paint(); showAlert(t('sites_checkingSourceConnection', 'Checking the $1 connection…', site));
void refresh();
void loadRoots();
