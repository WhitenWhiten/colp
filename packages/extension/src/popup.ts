import { hydrateIcons } from './icons.js';
import { initializeCapturePopup, allowManualCapture } from './capture/popup.js';
import { showManualCaptureExistence, repaintExistenceSaveControl } from './capture/manual-existence.js';
import { bindAuthSnapshot, element, isSavableUrl } from './popup-dom.js';
import { createPopupFeedbackUi, UNSAVABLE_FEEDBACK } from './popup-feedback-ui.js';
import { bindPopupClassification } from './popup-classification.js';
import type { BookmarkPreferencesResponse, ExtensionRequest, ExtensionResponse, NativeWaitResponse, PublicAuthState,
  SaveStatusResponse } from './types.js';
import { effectiveAiTagMode } from './bookmark-preferences.js';
import { AUTH_SNAPSHOT, parseAuthSnapshot } from './auth-snapshot.js';
import { COLLECTION_BINDING, LIBRARY_STATE, boundLibrary, type Library } from './library.js';
import { paintDestSync } from './popup-dest-sync.js';
import { paintDigestNote } from './popup-digest.js';
import { bindEditExisting } from './popup-edit-existing.js';

import { readSaveFeedback, SAVE_FEEDBACK_PERMISSION, saveFeedbackIsError } from './save-feedback.js';
import { readPopupDraft, writePopupDraft, clearPopupDraft, type PopupDraft } from './popup-draft.js';
import { savePopupNativePage } from './popup-native-save.js';
import { bindPopupRule } from './popup-rule.js';
import { bindPopupRisk } from './popup-risk.js';
import { bindSaveFolderPicker } from './save-folder-ui.js';
import { automationSaveLine, writeLastSave } from './save-status.js';
import { bindClearIconAction } from './clear-icon-ui.js';
import { presentIconPolicyFeedback as iconPolicyFeedback } from './icon-policy-feedback.js';
import { bindPopupCredits } from './popup-credits.js';
import { bindPopupSavePosition } from './popup-save-position.js';
import { bindDestUi, bindUrlDisplay } from './popup-dest-ui.js';
import { bindDeviceSave, canSaveNow, DEVICE_FOLDER_SCOPE, paintSaveGate, saveButtonLabel } from './popup-device-save.js';
import { bindPopupHeader } from './popup-header.js';
import { createPopupNote } from './popup-note.js';
import { bindPopupFields } from './popup-fields.js';
import { bindManualFooter } from './popup-footer.js';
import { bindBookmarkPermission } from './popup-permission.js';
import { captureAnnotation, closeAnnotationStore } from './popup-annotations.js';
import { bindPopupPin } from './popup-pin.js';
import { paintCaptureAlert, paintFavicon, paintStatusLine, setFooterMode } from './popup-shell.js';
import { t } from './i18n.js';
import { bindPageLanguage } from './page-language.js';

hydrateIcons(document); void bindPageLanguage();

const header = bindPopupHeader();
const save = element('save') as HTMLButtonElement;
const openNativeWait = element('open-native-wait') as HTMLButtonElement;
const titleInput = element('tab-title') as HTMLTextAreaElement;
const urlInput = element('tab-url') as HTMLInputElement;
const urlDisplay = element('tab-url-display') as HTMLButtonElement;
const favicon = element('tab-favicon') as HTMLImageElement;
const fieldRows = element('pp-fields');
const destFolder = element('dest-folder');
const folderNewName = element('folder-new-name') as HTMLInputElement;
element('popup-foot');
const note = createPopupNote(element('pp-note'));
let tabTitle = '';
let tabUrl = '';
let tabFavIcon = '';
let busy = false;
let saveContextPrimed = false;
let lastMountNativeIds: readonly string[] = [];
/** A listed native wait keeps the deep link reachable even when save status is calm. */
let nativeWaitPending = false;
/* The save-lane feedback surface lives in its own module (source-size cap). */
const feedbackUi = createPopupFeedbackUi({
  save, fields: fieldRows, note, openNativeWait,
  currentTabUrl: () => tabUrl, nativeWaitPending: () => nativeWaitPending,
});
const { setFeedback, paintStatus, reflectNativeWaitLink, reflectSavable } = feedbackUi;
let savedCloseTimer: number | undefined;
/** The saved state shows a rule's "could not act" line in the alert; Edit takes it down again. */
let ruleAlert = false;
let currentAuthState: PublicAuthState | undefined;
const savePosition = bindPopupSavePosition();
const fields = bindPopupFields(() => { handleEditAfterSave(); persistDraft(); });
const permission = bindBookmarkPermission(() => {
  saveContextPrimed = false;
  const collection = selectedCollection();
  void initSaveTarget(collection?.id);
  void primeSaveContext(collection?.id);
});

/** The automatic result listens for folder picks while it is on screen (capture/popup.ts). */
let pickHandler: ((nativeId: string) => void | Promise<void>) | undefined;
const pin = bindPopupPin({ button: element('folder-pin') as HTMLButtonElement, hint: element('folder-pin-hint') }, () => folders.chosenFolderId());
const folders = bindSaveFolderPicker({
  get remember() { return document.body.dataset.captureMode !== 'automatic'; },
  destToggle: element('dest-toggle') as HTMLButtonElement, destPanel: element('dest-panel'), folderCurrent: destFolder,
  folderParent: element('dest-parent'), folderTree: element('folder-tree'), folderNew: element('folder-new') as HTMLFormElement, folderNewName,
  folderNewOpen: element('folder-new-open') as HTMLButtonElement, folderNewLabel: element('folder-new-label'),
  folderCreate: element('folder-create'), destSearch: element('dest-search') as HTMLInputElement,
  persistDraft, setFeedback, onChosen: () => { void paintDestNote(); void pin.refresh(); },
  onPick: (id) => { fields.setAiPick(false); rule.picked(); return pickHandler?.(id); },
});
/* A matching rule shows its folder before Save; the user's own pick always wins. */
const currentPage = () => { const url = urlInput.value.trim() || tabUrl; return url ? { url, title: titleInput.value.trim() || tabTitle || url } : null; };
const rule = bindPopupRule({ folders, fields, onChange: () => classification?.ruleChanged(), page: currentPage });
/* Risk alerts are asked for beside the rule, whatever it decides; they never touch the folder (doc 17 RS-18). */
const risk = bindPopupRisk({ notice: element('risk-notice'), page: currentPage });
urlInput.addEventListener('change', () => { void rule.refresh(); void risk.refresh(); });
bindDestUi({ destToggle: element('dest-toggle') as HTMLButtonElement, destPanel: element('dest-panel'), destSearch: element('dest-search') as HTMLInputElement });
const editExisting = bindEditExisting({ titleInput, tabTitle: () => tabTitle, save, remove: element('remove-bookmark') as HTMLButtonElement,
  folders, commitFolder: () => folders.commit(selectedCollection()?.id ?? DEVICE_FOLDER_SCOPE), setFeedback, annotation: fields.annotation, pin });
let library: Library | undefined;
const deviceSave = bindDeviceSave({ enableControls: enableSaveControls, initTarget: initSaveTarget,
  showExistence: showManualCaptureExistence, showPersistedFeedback: showPersistedSaveFeedback, currentUrl: () => tabUrl });

const credits = bindPopupCredits({ summary: null, available: null, reserved: null, price: null, status: null, open: null }, () => currentAuthState);
let classification: ReturnType<typeof bindPopupClassification> | undefined;
function manualClassification() {
  return classification ??= bindPopupClassification({ fields: [titleInput, urlInput], // Local suggestions need only the page.
    input: () => { const collection = document.body.dataset.state === 'connected' ? selectedCollection() : undefined, url = urlInput.value.trim() || tabUrl;
      return url ? { ...(collection ? { collectionId: collection.id } : {}), title: titleInput.value.trim() || tabTitle || t('common_untitledPage', 'Untitled page'), url } : null; },
    inScope: async () => !await folders.isOutOfRange(), chooseFolder: (id, anyFolder) => folders.chooseSuggestedFolder(id, anyFolder),
    folderPicked: folders.userPicked, ruleFolder: rule.decides,
    getManagedPrice: credits.readPrice,
    chip: element('folder-suggest') as HTMLButtonElement, chipLabel: element('folder-suggest-label'), note, tags: fields.tags,
    onApplied: () => fields.setAiPick(true), retry: element('folder-retry') as HTMLButtonElement,
    tagMode: async (local) => {
      const reply = await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' }) as BookmarkPreferencesResponse;
      return effectiveAiTagMode(reply?.ok ? reply.preferences : undefined, local);
    },
  });
}

save.addEventListener('click', (event) => { void submit(event.isTrusted && navigator.userActivation.isActive); });
bindManualFooter(setFeedback);
const refreshClearIcon = bindClearIconAction({ isSavableUrl, setFeedback });
function handleEditAfterSave(): void {
  if (document.body.dataset.state === 'saved') restoreSave();
}

/* The domain line starts as a one-line host/path summary; clicking it reveals
   the real input for editing. */
const paintUrlDisplay = bindUrlDisplay(urlDisplay, urlInput, () => urlInput.value.trim() || tabUrl);

element('dest-panel').addEventListener('click', () => {
  handleEditAfterSave();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void submit(event.isTrusted && navigator.userActivation.isActive);
  }
});
for (const field of [titleInput, urlInput] as readonly HTMLElement[]) {
  field.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    event.preventDefault();
    void submit(event.isTrusted && navigator.userActivation.isActive);
  });
}
for (const field of [titleInput, urlInput, folderNewName] as readonly HTMLElement[]) {
  field.addEventListener('input', () => {
    // A title is one line: pasted line breaks become spaces.
    if (field === titleInput && /[\r\n]/u.test(titleInput.value)) titleInput.value = titleInput.value.replace(/\s*[\r\n]+\s*/gu, ' ');
    handleEditAfterSave();
    persistDraft();
  });
}
favicon.addEventListener('error', () => { paintFavicon(undefined); });
window.addEventListener('pagehide', () => { closeAnnotationStore(); }, { once: true });
void initializeCapturePopup({ folders, fields, note, pin, onPick: (handler) => { pickHandler = handler; },
  getManagedPrice: async () => { await initializeResultHeader(); return credits.readPrice(); },
}).then(automatic => { if (!automatic) return initialize(); return initializeResultHeader(); });
// What the toolbar's count means, in both modes; anything about this page outranks it.
void paintDigestNote(note);
document.addEventListener('known:existence-cleared', () => {
  if (document.body.dataset.state === 'saving' || document.body.dataset.state === 'saved') return;
  save.textContent = saveButtonLabel(currentAuthState); void permission.reflect();
});
/**
 * First paint never waits on the service worker: the last known auth state
 * and the library binding are rendered straight from chrome.storage,
 * so the panel is usable instantly and fully offline. The worker round trip
 * only reconciles afterwards (stale-while-revalidate).
 */
async function initialize(): Promise<void> {
  const [cached] = await Promise.all([
    chrome.storage.local.get([LIBRARY_STATE, COLLECTION_BINDING, AUTH_SNAPSHOT]),
    readActiveTab(),
  ]);
  if (tabUrl && isSavableUrl(tabUrl)) void showManualCaptureExistence(tabUrl);
  // Restore unfinished edits for this page before anything else reads the fields.
  restoreDraft(await readPopupDraft(tabUrl));
  void savePosition.refresh();
  const snapshot = parseAuthSnapshot(cached[AUTH_SNAPSHOT]);
  if (snapshot) {
    renderAuth(snapshot);
    if (snapshot.status === 'connected') {
      library = boundLibrary(cached, snapshot.serverOrigin);
      enableSaveControls();
      void initSaveTarget(selectedCollection()?.id);
      void primeSaveContext(selectedCollection()?.id);
    } else deviceSave.init(snapshot);
  }
  const response = await request({ kind: 'known.auth.status' });
  // A failed worker round trip must not tear down a usable cached panel.
  const settled = response.ok || !snapshot ? response.state : snapshot;
  if (!snapshot || settled.status !== snapshot.status || settled.accountLabel !== snapshot.accountLabel
      || settled.avatarUrl !== snapshot.avatarUrl || settled.errorCode !== snapshot.errorCode) {
    renderAuth(settled);
  }
  if (settled.status !== 'connected') { deviceSave.init(settled); return; }
  void savePosition.refresh();
  if (!snapshot || snapshot.status !== 'connected') {
    library = boundLibrary(cached, settled.serverOrigin);
    enableSaveControls();
    void initSaveTarget(selectedCollection()?.id);
    void primeSaveContext(selectedCollection()?.id);
  }
  void refreshBoundCollection();
  void Promise.all([refreshClearIcon(tabUrl), showManualCaptureExistence(tabUrl)]);
  void showPersistedSaveFeedback();
  void probeNativeWait();
}

/** The automatic result owns the body; the shared header still needs the account. */
let resultHeaderReady: Promise<void> | undefined;
function initializeResultHeader(): Promise<void> {
  return resultHeaderReady ??= (async () => {
    const cached = parseAuthSnapshot((await chrome.storage.local.get(AUTH_SNAPSHOT))[AUTH_SNAPSHOT]);
    if (cached) { currentAuthState = cached; header.paint(cached); }
    const response = await request({ kind: 'known.auth.status' });
    if (response.ok) { currentAuthState = response.state; header.paint(response.state); }
  })();
}

/**
 * Resolve the save destination when the popup opens, not when Save is
 * pressed: the worker provisions/refreshes the save-context cache, which is
 * what makes the folder picker appear on the very first save of a fresh
 * install instead of only after one blind save.
 */
async function primeSaveContext(collectionId: string | undefined): Promise<void> {
  if (!collectionId || saveContextPrimed) return;
  saveContextPrimed = true;
  try {
    const context = await chrome.runtime.sendMessage({ kind: 'known.favicon.save-context' }) as
      { readonly ok?: boolean; readonly parentNativeId?: string } | undefined;
    if (context?.ok && typeof context.parentNativeId === 'string' && !folders.chosenFolderId()) {
      await initSaveTarget(selectedCollection()?.id ?? collectionId);
    }
  } catch { /* The picker is sugar; saving still resolves its own context. */ }
}

async function initSaveTarget(collectionId: string | undefined): Promise<void> {
  const status = await requestSaveStatus();
  lastMountNativeIds = status?.ok ? status.mountNativeIds : [];
  reflectNativeWaitLink(status?.ok === true && status.status.kind === 'action-required');
  await folders.init(collectionId ?? DEVICE_FOLDER_SCOPE, lastMountNativeIds, status?.ok ? status.privateNativeIds : []);
  await editExisting.reapply();
  void risk.refresh();
  // The rule's folder first, so an automatic suggestion knows whether to ask for tags only.
  await rule.refresh();
  void manualClassification().refresh(collectionId);
  if (status?.ok) paintStatus(status.status);
  else note.set('status', undefined);
}

async function requestSaveStatus(nativeId?: string): Promise<SaveStatusResponse | undefined> {
  try {
    return await chrome.runtime.sendMessage({ kind: 'known.save.status', ...(nativeId ? { nativeId } : {}) }) as SaveStatusResponse;
  } catch { return undefined; }
}

/** A parked native write can outlive the current engine phase, so read its list too. */
async function probeNativeWait(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'known.nativeWait.list' }) as NativeWaitResponse;
    if (response.ok === true && 'waits' in response && response.waits.length > 0) {
      nativeWaitPending = true;
      reflectNativeWaitLink(false);
    }
  } catch { /* The action-required status still drives the link. */ }
}

function enableSaveControls(): void {
  if (!reflectSavable()) return;
  save.disabled = false;
  save.textContent = saveButtonLabel(currentAuthState);
  fieldRows.hidden = false;
  void permission.reflect();
  repaintExistenceSaveControl();
}

async function readActiveTab(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs[0];
  tabTitle = typeof tab?.title === 'string' ? tab.title : t('common_untitledPage', 'Untitled page');
  tabUrl = typeof tab?.url === 'string' ? tab.url : '';
  tabFavIcon = typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : '';
  titleInput.value = tabTitle;
  urlInput.value = tabUrl;
  paintUrlDisplay();
  paintFavicon(tabFavIcon);
}

function persistDraft(): void {
  if (!tabUrl) return;
  void writePopupDraft({
    url: tabUrl, title: titleInput.value, editedUrl: urlInput.value, newFolderName: folderNewName.value,
    ...(savePosition.draft() ? { insertPosition: savePosition.draft() } : {}), ...fields.draft(),
  });
}

function restoreDraft(draft: PopupDraft | undefined): void {
  if (!draft) return;
  if (draft.title) titleInput.value = draft.title;
  if (draft.editedUrl) urlInput.value = draft.editedUrl;
  if (draft.newFolderName) folderNewName.value = draft.newFolderName;
  fields.restore(draft);
  paintUrlDisplay();
  savePosition.restore(draft.insertPosition);
}

function renderAuth(state: PublicAuthState): void {
  currentAuthState = state;
  if (state.status !== 'connected') void classification?.refresh(undefined);
  else void savePosition.refresh();
  document.body.dataset.state = state.status === 'connected' ? 'connected' : state.status;
  header.paint(state);
  paintSaveGate(state);
  credits.render(state);
}

bindAuthSnapshot(() => currentAuthState, (state) => {
  // The result panel owns the body; only the header follows a refreshed avatar.
  if (document.body.dataset.captureMode === 'automatic') { currentAuthState = state; header.paint(state); } else renderAuth(state);
});

/**
 * The bound library is read, never chosen here (choosing rebinds the whole
 * sync scope). When the worker's answer differs from the cached paint, the
 * save target follows it.
 */
async function refreshBoundCollection(): Promise<void> {
  const before = library?.id;
  library = boundLibrary(await chrome.storage.local.get([COLLECTION_BINDING, LIBRARY_STATE]), currentAuthState?.serverOrigin);
  const after = selectedCollection()?.id;
  void paintDestNote();
  if (after === before) return;
  saveContextPrimed = false;
  void initSaveTarget(after);
  void primeSaveContext(after);
}

function selectedCollection(): { id: string; title: string } | undefined {
  return library;
}

/* The passive sync fact under the fields: said only when a save here would not sync, derived from the folder. */
let destNotePass = 0;
async function paintDestNote(): Promise<void> {
  const pass = ++destNotePass;
  if (currentAuthState?.status !== 'connected' || !selectedCollection()) {
    paintDestSync(note, { kind: currentAuthState?.status !== 'connected' ? 'none' : 'sync-off' });
    return;
  }
  const firstRun = await chrome.runtime.sendMessage({ kind: 'known.firstRun.status' }).catch(() => undefined) as { ok?: boolean; firstRun?: string } | undefined;
  if (pass !== destNotePass) return;
  if (firstRun?.ok && (firstRun.firstRun === 'none' || firstRun.firstRun === 'deferred')) {
    paintDestSync(note, { kind: 'sync-off' }); return;
  }
  const target = await folders.syncTarget();
  if (pass !== destNotePass) return;
  paintDestSync(note, target.kind !== 'local' ? { kind: target.kind === 'synced' ? 'synced' : 'none' }
    : { kind: 'local', folderId: folders.chosenFolderId() });
}

async function submit(hasUserGesture: boolean): Promise<void> {
  if (document.body.dataset.state === 'saved') { restoreSave(); return; }
  if (busy) return;
  if (!canSaveNow(currentAuthState, document.body.dataset.state)) {
    setFeedback(t('popup_signSavePage', 'Sign in to save this page.'));
    return;
  }
  if (!hasUserGesture) {
    setFeedback(t('popup_clickSaveSavePage', 'Click Save to save this page.'));
    return;
  }
  fields.tags.commitPending();
  const title = titleInput.value.trim() || tabTitle || t('common_untitledPage', 'Untitled page');
  const url = urlInput.value.trim() || tabUrl;
  if (!url || !isSavableUrl(url)) {
    setFeedback(UNSAVABLE_FEEDBACK, 'error');
    return;
  }
  if (await editExisting.submit(title, url)) return; // Already bookmarked here: rename/move it, like the native star.
  if (!await allowManualCapture(url)) { setFeedback(t('popup_tickSaveAnotherCopy', 'Tick "Save another copy" to save this page again.')); return; }
  if (busy) return;
  classification?.reset();
  busy = true;
  document.body.dataset.state = 'saving';
  save.setAttribute('aria-busy', 'true');
  save.disabled = true;
  save.textContent = t('common_saving', 'Saving…');
  setFeedback('');
  try {
    const frozenInsertPosition = await savePosition.forSave();
    const granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }).catch(() => false);
    if (!granted) {
      permission.show();
      setFeedback(SAVE_FEEDBACK_PERMISSION, 'error');
      restoreSave();
      return;
    }
    const collection = currentAuthState?.status === 'connected' ? selectedCollection() : undefined;
    const collectionId = collection?.id;
    const chosen = folders.chosenFolderId();
    // The picker and local cache are sufficient. Account/session renewal cannot precede native saving.
    // With a rule's folder on the pill, the worker gets the folder the rule replaces and decides again.
    const target = rule.target(chosen);
    const parentNativeId = target.parentNativeId;
    // A rule's folder on the pill stands in for a folder of the save's own.
    if (!parentNativeId && !rule.decides()) {
      restoreSave();
      setFeedback(t('save_chooseFolderBeforeSaving', 'Choose a folder before saving.'));
      await folders.open(); return;
    }
    const localOnly = await folders.isOutOfRange();
    const live = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const favIconUrl = typeof live[0]?.favIconUrl === 'string' ? live[0].favIconUrl : tabFavIcon;
    let nativeId = '', ruleLine: ReturnType<typeof automationSaveLine> = null;
    // Typed and accepted AI tags share the worker-owned local save and metadata sync lifecycle.
    const typed = captureAnnotation({ tags: fields.tags.tags(), note: fields.noteField.value });
    const annotation = pin.pinned() ? { ...(typed ?? { tags: [], note: null }), pinned: true as const } : typed;
    const saved = await savePopupNativePage({title,url,favIconUrl},parentNativeId,localOnly?undefined:collectionId,
      frozenInsertPosition, annotation, target.folderChoice);
    nativeId = saved.nativeId;
    await rule.saved(saved.task);
    ruleLine = saved.task.disposition === 'new' ? automationSaveLine(saved.task.automation) : null;
    if (parentNativeId) await folders.commit(collectionId ?? DEVICE_FOLDER_SCOPE);
    if (nativeId) {
      const savedIn = folders.chosenFolderId() || parentNativeId;
      await writeLastSave({
        nativeId, localOnly, ...(savedIn ? { parentNativeId: savedIn } : {}),
        ...(collectionId ? { collectionId } : {}),
      });
    }
    document.body.dataset.state = 'saved';
    save.removeAttribute('aria-busy');
    /* 'Edit' is a live action: a click routes through submit() to restoreSave(). */
    save.textContent = t('common_edit', 'Edit'); save.disabled = false;
    save.classList.replace('btn-primary', 'btn-secondary');
    setFooterMode('saved');
    paintStatusLine({ icon: 'check-circle', text: t('popup_savedTo', 'Saved to $1', destFolder.textContent?.trim() || t('common_thisBrowserLower', 'this browser')),
      ...(saved.task.automation?.outcome === 'placed' ? { meta: t('automation_placementRule', 'Rule “$1”', saved.task.automation.rule.name) } : {}) });
    void clearPopupDraft();
    setFeedback('');
    // A rule that stood aside says so; one that matched but could not act gets the alert, as in the
    // automatic result, and the popup stays a little longer for it.
    note.set('rule', ruleLine && !ruleLine.attention && saved.task.automation?.outcome !== 'placed' ? ruleLine.text : undefined);
    if (ruleLine?.attention) { paintCaptureAlert(ruleLine.text); ruleAlert = true; }
    if (currentAuthState?.status === 'connected' || currentAuthState?.status === 'offline') iconPolicyFeedback((text, tone) => setFeedback(text, tone));
    if (nativeId) window.setTimeout(() => { void projectFollowUp(nativeId); }, 400);
    /* The saved state closes the popup after a beat — unless the user keeps
       interacting (then the Edit affordance stays in charge). */
    if (savedCloseTimer !== undefined) window.clearTimeout(savedCloseTimer);
    savedCloseTimer = window.setTimeout(() => { window.close(); }, ruleLine?.attention ? 5000 : 1500);
    const cancelClose = () => {
      if (savedCloseTimer !== undefined) {
        window.clearTimeout(savedCloseTimer);
        savedCloseTimer = undefined;
      }
    };
    document.addEventListener('pointerdown', cancelClose, { once: true });
    document.addEventListener('focusin', cancelClose, { once: true });
  } catch {
    setFeedback(t('popup_couldntSavePageCheck', "Couldn't save this page. Check that the browser allows bookmarks, then try again."), 'error');
    restoreSave();
  }
}

async function projectFollowUp(nativeId: string): Promise<void> {
  const status = await requestSaveStatus(nativeId);
  if (status?.ok) paintStatus(status.status);
}

function restoreSave(): void {
  const wasSaved = document.body.dataset.state === 'saved';
  if (savedCloseTimer !== undefined) {
    window.clearTimeout(savedCloseTimer);
    savedCloseTimer = undefined;
  }
  busy = false;
  document.body.dataset.state = currentAuthState?.status ?? 'signed_out';
  save.removeAttribute('aria-busy');
  if (!reflectSavable()) return;
  save.disabled = false;
  save.textContent = saveButtonLabel(currentAuthState);
  save.classList.replace('btn-secondary', 'btn-primary');
  if (wasSaved) { paintStatusLine(undefined); note.set('rule', undefined); }
  if (ruleAlert) { paintCaptureAlert(undefined); ruleAlert = false; }
  setFooterMode('manual');
  // The page now has a bookmark: Edit reopens it for editing in place.
  if (wasSaved && tabUrl) void showManualCaptureExistence(tabUrl); else editExisting.paint();
}

async function showPersistedSaveFeedback(): Promise<void> {
  const last = await readSaveFeedback();
  if (!last || last.entry === 'popup') return;
  setFeedback(last.message, saveFeedbackIsError(last.code) ? 'error' : last.code === 'saved' ? 'ok' : '');
}

async function request(message: ExtensionRequest): Promise<ExtensionResponse> {
  try { return await chrome.runtime.sendMessage(message) as ExtensionResponse; }
  catch {
    return { ok: false, error: 'extension_unavailable',
      state: { status: 'error', environment: 'production', serverOrigin: '', errorCode: 'extension_unavailable' } };
  }
}
