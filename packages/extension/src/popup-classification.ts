import { t, tn } from './i18n.js';
import { classificationErrorFeedback, paintClassificationError } from './classification-error-feedback.js';
import { AUTHORITY_GENERATION_KEY } from './authority-fence.js';
import { validClassificationRequest, type ClassificationRequest } from './classification-messages.js';
import type { ClassificationSettings } from './classification-product-client.js';
import type { ClassificationNativeFolder } from './classification-folder.js';
import { LOCAL_CLASSIFICATION_ENABLED, localClassificationEnabled } from './classification-local-session.js';
import { classificationDocument } from './classification-intent.js';
import type { ClassificationPreviewReply as PreviewReply } from './classification-preview-reply.js';
import { manualClassificationRequested } from './manual-classification.js';
import type { AiTagMode } from './bookmark-preferences.js';
import type { PopupNote } from './popup-note.js';
import type { TagInput } from './popup-tags.js';

/** `collectionId` is present only when signed in; local mode never needs it. */
interface PageInput { readonly collectionId?: string; readonly title: string; readonly url: string }
type Managed = { readonly priceVersion: string; readonly unitPoints: number };
/** What the one suggestion chip offers: run a suggestion, wait for it, or apply its folder. */
export type SuggestState = 'hidden' | 'run' | 'busy' | 'apply';

export interface PopupClassificationHost {
  readonly input: () => PageInput | null;
  readonly inScope: () => Promise<boolean>;
  /** `anyFolder` accepts any personal browser folder (local suggestions); otherwise only synced ones. */
  readonly chooseFolder: (nativeId: string, anyFolder: boolean) => Promise<boolean>;
  readonly folderPicked?: () => boolean;
  /** The title and URL fields: editing either invalidates the current suggestion. */
  readonly fields: readonly HTMLElement[];
  readonly getManagedPrice?: () => Promise<Managed>;
  /** The "✦ Suggest" / "Suggesting…" / folder chip beside the folder pill. */
  readonly chip: HTMLButtonElement;
  readonly chipLabel?: HTMLElement;
  readonly note: PopupNote;
  readonly tags: TagInput;
  /** This browser's tag preference for the provider in use (local: the user's own AI). Absent: Suggest. */
  readonly tagMode?: (local: boolean) => Promise<AiTagMode>;
  /** The suggested folder was applied: the popup marks the pick as the AI's. */
  readonly onApplied?: () => void;
  /** "Suggest another" beside the "AI pick" mark: asks again without the folders already turned down. */
  readonly retry?: HTMLButtonElement;
  /** Saved results expose a request only after seeding an AI pick or an abstention with candidates. */
  readonly retryOnly?: boolean;
  readonly onRequest?: () => void;
  /**
   * True while one of the account's rules chooses the folder. The user's own AI
   * is then asked for tags only (`folder: false`), or nothing when tags are off;
   * a Know-N suggestion is not requested at all.
   */
  readonly ruleFolder?: () => boolean;
}

/** The Product contract's cap on turned-down folders per request. */
const MAX_REJECTED_FOLDERS = 8;

/**
 * The popup's AI suggestion lane. It owns one chip: "✦ Suggest" when a
 * suggestion can be requested, "Suggesting…" while it runs, then the
 * suggested folder, which a click applies. Suggested tags follow the tag
 * preference: Off asks for none, Suggest offers them under the tag field and
 * Add puts up to three in it, for the user to remove before Save. Anything
 * else it has to say becomes the popup's single note line, and the credit
 * cost appears there only when Know-N credits will be spent.
 * Once a suggestion is applied, the retry button asks for a different folder
 * and applies it in place of the old one: the request names every folder
 * turned down so far, so none can come back.
 */
export function bindPopupClassification(host: PopupClassificationHost) {
  const chip = host.chip;
  const label = host.chipLabel ?? chip;
  const { note, tags } = host;
  let tagsEnabled = false, tagMode: AiTagMode = 'suggest', managedBilling = false, managedPrice: Managed | undefined;
  let collectionId: string | undefined, version = 0, connectionVersion = 0;
  let intent: Extract<ClassificationRequest, { kind: 'known.classification.preview' | 'known.classification.local-preview' }> | undefined;
  let enabled = false, local = false, initialized = false, busy = false, reuse = false, automaticAttempted = false, priceChanged = false;
  let nativeFolder: ClassificationNativeFolder | null = null;
  let state: SuggestState = 'hidden';
  /** The applied suggestion, the folders turned down since, and whether the running request is a retry. */
  let applied: ClassificationNativeFolder | null = null, rejected: string[] = [], retrying = false, exhausted = false;
  let requireCandidate = false, retryReady = false;
  const retry = host.retry;

  const selectedTags = () => tags.aiTags().slice(0, 3);
  const canAsk = () => enabled && !busy && !(managedBilling && !managedPrice);
  const ruled = () => host.ruleFolder?.() === true;
  /** With a rule's folder, only the user's own AI may run, and only for tags. */
  const tagsOnlyBlocked = () => ruled() && (!local || !tagsEnabled);
  function paintChip(next: SuggestState): void {
    state = next;
    // A retry spins its own button instead of showing "Suggesting…".
    chip.hidden = next === 'hidden' || (next === 'busy' && retrying) || (next === 'run' && host.retryOnly === true && !retryReady)
      || (next === 'run' && tagsOnlyBlocked());
    chip.disabled = next === 'busy' || (next === 'run' && !canAsk());
    if (next === 'busy') chip.setAttribute('aria-busy', 'true'); else chip.removeAttribute('aria-busy');
    chip.dataset.state = next;
    label.textContent = next === 'busy' ? t('popup_suggesting', 'Suggesting…')
      : next === 'apply' ? nativeFolder?.title ?? ''
        : next === 'run' ? (reuse ? t('common_checkAgain', 'Check again') : ruled() ? t('popup_suggestTags', 'Suggest tags') : requireCandidate
          ? t('popup_classifyAgain', 'Suggest again') : retryReady ? t('common_tryAgain', 'Try again') : t('popup_suggest', 'Suggest')) : '';
    chip.title = next === 'apply' ? t('popup_suggestedFolder', 'Suggested folder')
      : local && next !== 'hidden' ? t('popup_localModeSuggestionsCome', 'Suggestions are sent directly to your own AI service.') : '';
    renderCost();
    paintRetry();
  }
  function paintRetry(): void {
    if (!retry) return;
    const spinning = busy && retrying;
    retry.hidden = !spinning && (!applied || !enabled || !reuse && (exhausted || rejected.length >= MAX_REJECTED_FOLDERS));
    retry.disabled = spinning || !canAsk();
    if (spinning) retry.setAttribute('aria-busy', 'true'); else retry.removeAttribute('aria-busy');
    const label = spinning ? t('popup_suggesting', 'Suggesting…') : reuse ? t('common_checkAgain', 'Check again')
      : t('popup_suggestAnotherFolder', 'Suggest another folder');
    const cost = managedBilling && managedPrice ? tn('popup_usesCredits', managedPrice.unitPoints, 'Uses $1 credit', 'Uses $1 credits') : '';
    retry.title = cost && !spinning ? `${label} · ${cost}` : label;
    retry.setAttribute('aria-label', retry.title);
  }
  /** Credits are mentioned only while a Know-N-billed request is about to run or running. */
  function renderCost(): void {
    const pending = (state === 'run' || state === 'busy') && managedBilling && managedPrice;
    note.set('cost', !pending ? undefined : priceChanged
      ? tn('popup_priceChangedUsesCredits', managedPrice!.unitPoints, 'The price changed. Uses $1 credit', 'The price changed. Uses $1 credits')
      : tn('popup_usesCredits', managedPrice!.unitPoints, 'Uses $1 credit', 'Uses $1 credits'));
  }
  const say = (text: string | Node | undefined, tone: '' | 'error' = '') => { note.set('classify', text, tone); };
  const resetInput = () => {
    tags.setAiSuggestions([]); version++; intent = undefined; nativeFolder = null; reuse = false; busy = false;
    applied = null; rejected = []; retrying = false; exhausted = false; requireCandidate = false; retryReady = false;
    say(undefined); paintChip(enabled ? 'run' : 'hidden');
  };
  const resetMode = () => { managedBilling = false; managedPrice = undefined; renderCost(); };
  for (const field of host.fields) field.addEventListener('input', () => {
    const savedRetry = host.retryOnly && (retryReady || applied !== null), force = requireCandidate;
    resetInput();
    if (savedRetry && enabled) { retryReady = true; requireCandidate = force; paintChip('run'); }
  });

  chip.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    if (state === 'apply') void applyFolder();
    else if (state === 'run' && navigator.userActivation.isActive) void preview();
  });
  retry?.addEventListener('click', (event) => {
    if (!event.isTrusted || !navigator.userActivation.isActive || busy || !applied) return;
    if (!reuse && (exhausted || rejected.length >= MAX_REJECTED_FOLDERS)) return;
    // A retry-safe failure resends the identical command; anything else turns down
    // the applied folder and any alternative still on offer, then asks anew.
    if (!reuse || !intent) {
      for (const folder of [applied, state === 'apply' ? nativeFolder : null]) {
        if (folder && !rejected.includes(folder.folderId) && rejected.length < MAX_REJECTED_FOLDERS) rejected.push(folder.folderId);
      }
      reuse = false; intent = undefined;
    }
    void preview(false, true);
  });

  async function applyFolder(): Promise<void> {
    if (!nativeFolder) return;
    const selected = nativeFolder, at = version;
    const unavailable = () => say(t('popup_folderNoLongerAvailable', 'This folder is no longer available. Choose a folder manually.'));
    let ok: boolean;
    if (local) {
      ok = await host.chooseFolder(selected.nativeId, true);
    } else {
      if (host.input()?.collectionId !== collectionId) return;
      const current = await chrome.runtime.sendMessage({ kind: 'known.classification.folder', collectionId, folderId: selected.folderId, userGesture: true })
        .catch(() => null) as PreviewReply | null;
      if (at !== version) return;
      ok = current?.ok === true && current.nativeFolder?.folderId === selected.folderId && await host.chooseFolder(current.nativeFolder.nativeId, false);
    }
    if (at !== version) return;
    if (ok) { applied = selected; say(undefined); paintChip('hidden'); host.onApplied?.(); } else {
      // A saved capture's correction may be awaiting confirmation: its chip replays that same edit.
      if (!host.retryOnly) unavailable();
      paintChip(host.retryOnly ? 'apply' : 'hidden');
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && (changes[AUTHORITY_GENERATION_KEY]
      || changes['known.sync.collection.v1']?.newValue !== undefined
      && changes['known.sync.collection.v1']?.newValue !== changes['known.sync.collection.v1']?.oldValue))
      || (area === 'session' && changes['known.auth.credential.v1'])) void refresh(undefined);
    if (area === 'local' && changes[LOCAL_CLASSIFICATION_ENABLED]) void refresh(collectionId, true);
  });

  async function refresh(id: string | undefined, force = false): Promise<void> {
    if (id === collectionId && initialized && !force) return;
    initialized = true;
    collectionId = id; connectionVersion++; enabled = false; local = false;
    resetMode(); resetInput(); paintChip('hidden');
    const at = connectionVersion;
    // Local-first: the user's own provider works signed out, unsynced and on any browser folder.
    if (await localClassificationEnabled()) {
      const mode = await readTagMode(true);
      if (at !== connectionVersion) return;
      local = true; tagMode = mode; tagsEnabled = mode !== 'off'; enabled = true; paintChip('run');
      await suggestAutomatically();
      return;
    }
    if (!id) return;
    try {
      const reply = await chrome.runtime.sendMessage({ kind: 'known.classification.settings', collectionId: id }) as
        { ok: boolean; result?: { settings: ClassificationSettings }; error?: string; status?: number; local?: boolean };
      if (at !== connectionVersion) return;
      if (!reply?.ok || !reply.result) {
        if (reply?.error === 'reconnect_required') say(t('popup_signAgainExtensionSettings', 'Sign in again in the extension settings to get suggestions. You can still save.'));
        collectionId = undefined; return;
      }
      tagMode = await readTagMode(false);
      if (at !== connectionVersion) return;
      tagsEnabled = tagMode !== 'off' && reply.result.settings.autoTagMode !== 'off';
      managedBilling = reply.local !== true && reply.result.settings.executionMode === 'server_managed';
      if (managedBilling) {
        if (!host.getManagedPrice) throw new Error('credit_price_unavailable');
        try { managedPrice = await host.getManagedPrice(); } catch {
          if (at === connectionVersion) say(t('popup_classificationPricingIsntAvailable', "Suggestion pricing isn't available right now. You can still save."));
          return;
        }
        if (at !== connectionVersion) return;
      }
      enabled = true;
      paintChip('run');
      await suggestAutomatically();
    } catch { if (at === connectionVersion) { enabled = false; paintChip('hidden'); /* Native save stays available when Product/session/feature is unavailable. */ } }
  }

  async function readTagMode(isLocal: boolean): Promise<AiTagMode> {
    return await host.tagMode?.(isLocal).catch(() => 'suggest' as const) ?? 'suggest';
  }

  async function suggestAutomatically(): Promise<void> {
    if (automaticAttempted || document.body.dataset.captureMode !== 'manual') return;
    const at = version, authorityAt = connectionVersion;
    if (!await manualClassificationRequested().catch(() => false) || at !== version || authorityAt !== connectionVersion || busy) return;
    automaticAttempted = true;
    await preview(true);
  }

  async function preview(automatic = false, another = false): Promise<void> {
    const input = host.input();
    if (!enabled || busy || !input || (!local && input.collectionId !== collectionId) || tagsOnlyBlocked()) return;
    const folder = !ruled();
    host.onRequest?.();
    const before = version, authorityAt = connectionVersion;
    if (!local && folder && !await host.inScope()) {
      if (before === version) say(t('popup_chooseSyncedFolderBefore', 'Choose a synced folder before requesting suggestions.'));
      return;
    }
    if (before !== version || authorityAt !== connectionVersion) return;
    const at = ++version;
    busy = true; retrying = another; priceChanged = false; paintChip('busy');
    if (!reuse || !intent) {
      if (managedBilling && !managedPrice) {
        busy = false; paintChip(another ? 'hidden' : 'run');
        say(t('popup_classificationPricingIsntAvailable', "Suggestion pricing isn't available right now. You can still save."));
        return;
      }
      // The visible quote is the consent. Freeze the whole command, including
      // its billing cap, so checking an uncertain result cannot change intent.
      // Alternatives and retries after abstention leave the displayed tags alone.
      const body = classificationDocument(input, { tags: tagsEnabled && !another && !requireCandidate && !host.retryOnly, folder,
        requireCandidate: folder && requireCandidate, rejectedFolderIds: folder ? rejected : [],
        ...(!local && managedBilling ? { billing: { priceVersion: managedPrice!.priceVersion, maxPoints: managedPrice!.unitPoints } } : {}),
      });
      const trigger = automatic ? { automatic: true as const } : { userGesture: true as const };
      intent = local ? { kind: 'known.classification.local-preview', commandId: crypto.randomUUID(), ...trigger, document: body }
        : { kind: 'known.classification.preview', collectionId: input.collectionId!, commandId: crypto.randomUUID(), ...trigger,
          document: body };
    }
    if (!automatic && intent && 'automatic' in intent) {
      const { automatic: _automatic, ...retained } = intent;
      intent = { ...retained, userGesture: true };
    }
    const message = intent;
    say(undefined);
    try {
      if (!validClassificationRequest(message)) {
        reuse = false; say(t('popup_noSuggestionsPageCheck', 'No suggestions for this page. Check the URL and title.'), 'error'); return;
      }
      const reply = await chrome.runtime.sendMessage(message) as PreviewReply;
      if (at !== version) return;
      if (reply?.commandId && intent) intent = { ...intent, commandId: reply.commandId };
      if (reply?.skipped) { reuse = false; intent = undefined; busy = false; say(undefined); paintChip('run'); return; }
      if (!reply?.ok || !reply.result) {
        reuse = reply?.sameRequestRetrySafe === true;
        if (reply?.error === 'credit_price_changed') {
          // The new quote replaces the old one in the cost line; nothing is sent until the user asks again.
          reuse = false; intent = undefined; managedPrice = undefined; priceChanged = true;
          void refreshManagedPrice(authorityAt, at);
          return;
        }
        const fragment = document.createElement('span');
        paintClassificationError(fragment, classificationErrorFeedback(reply?.error, local, reuse));
        say(fragment, 'error');
        return;
      }
      reuse = false;
      const result = reply.result;
      exhausted = result.folder?.decision === 'later' && result.candidateCoverage.l1Included === 0;
      requireCandidate = result.folder?.decision === 'later' && result.candidateCoverage.l1Included > 0;
      retryReady = requireCandidate;
      nativeFolder = message.document.requested.folder ? reply.nativeFolder ?? null : null;
      const fillResult = 'automatic' in message;
      if (!message.document.requested.folder) { /* Tags only: the rule keeps the folder. */ }
      else if (result.folder?.decision === 'later') {
        say(another ? t('popup_noOtherFolderFits', 'No other folder fits. Keep this one or pick another.')
          : t('popup_noFolderSuggestedKeep', 'No folder suggested. Keep your chosen folder or pick another.'));
      } else if (!nativeFolder) {
        say(local ? t('popup_folderNoLongerAvailable', 'This folder is no longer available. Choose a folder manually.')
          : t('popup_suggestedFolderHasNot', 'The suggested folder has not synced to this browser. Choose a folder manually.'));
      }
      // The AI's tags are the ones it selected (confident, within its limit), whatever started the request.
      const candidates = result.tags.candidates.filter((candidate) => candidate.selected !== false).map((candidate) => candidate.tag);
      if (message.document.requested.tags) {
        tags.setAiSuggestions(candidates);
        if (tagMode === 'add') for (const tag of candidates.slice(0, Math.max(0, 3 - selectedTags().length))) tags.add(tag, 'ai');
      }
      busy = false;
      // "Suggest another" means the applied pick was turned down: its answer replaces it without a second click.
      if (nativeFolder && (another || fillResult && !host.folderPicked?.())) {
        paintChip('apply');
        const ok = await host.chooseFolder(nativeFolder.nativeId, local);
        if (at !== version) return;
        if (ok) { applied = nativeFolder; paintChip('hidden'); host.onApplied?.(); } else {
          // As in applyFolder: a saved capture's uncertain correction keeps its chip to replay the same edit.
          if (!host.retryOnly) say(t('popup_folderNoLongerAvailable', 'This folder is no longer available. Choose a folder manually.'));
          paintChip(host.retryOnly ? 'apply' : 'hidden');
        }
        return;
      }
      paintChip(nativeFolder && !fillResult ? 'apply' : requireCandidate && !another ? 'run' : 'hidden');
    } catch {
      if (at === version) { reuse = true; say(t('popup_connectionDroppedCheckAgain', 'The connection dropped. Check again, or save without suggestions.'), 'error'); }
    } finally {
      // A failed retry falls back to its own button; the applied folder stays.
      if (at === version && busy) { busy = false; paintChip(enabled && !another ? 'run' : 'hidden'); }
    }
  }

  async function refreshManagedPrice(at: number, versionAt: number): Promise<void> {
    if (!managedBilling || !host.getManagedPrice) return;
    try { const next = await host.getManagedPrice(); if (at === connectionVersion && versionAt === version) { managedPrice = next; paintChip(state); } }
    catch {
      if (at === connectionVersion && versionAt === version) {
        managedPrice = undefined; priceChanged = false; paintChip(state);
        say(t('popup_classificationPricingIsntAvailable', "Suggestion pricing isn't available right now. You can still save."));
      }
    }
  }
  return {
    refresh, reset: resetInput, selectedTags,
    /** A rule started or stopped choosing the folder: the chip follows (it never cancels a request in flight). */
    ruleChanged(): void { if (!busy) paintChip(state === 'apply' && ruled() ? 'hidden' : state === 'hidden' && enabled && !applied ? 'run' : state); },
    /** A saved result needs an explicit request; legacy abstentions may not retain their candidate count. */
    seedRetry(options: { readonly requireCandidate: boolean }): boolean {
      if (!enabled || busy) return false;
      requireCandidate = options.requireCandidate;
      retryReady = true;
      paintChip('run');
      return true;
    },
    /** Translate the saved pick to the current provider's ID space without requesting a new suggestion. */
    seedApplied(folder: { readonly nativeId: string; readonly title: string; readonly folderId?: string }): boolean {
      if (!enabled || busy || !local && !folder.folderId) return false;
      applied = { ...folder, folderId: local ? folder.nativeId : folder.folderId! };
      paintChip('hidden');
      return true;
    },
  };
}
