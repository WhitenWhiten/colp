import { CAPTURE_RUNTIME_COPY, type CaptureRuntimeView } from './runtime-control.js';
import { folderChoices } from '../library-folder-picker.js';
import { FIRST_RUN_LOCAL_ONLY } from '../first-run-draft.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { LOCAL_CLASSIFICATION_ENABLED, LOCAL_CLASSIFICATION_KEY } from '../classification-local-session.js';
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
};
/** A settings row: title and hint on the left, controls on the right (chrome.css `.set-row`). */
function settingsRow(title: string, hint?: string, ...controls: Node[]) {
  const row = element('div', undefined, 'set-row'), text = element('div', undefined, 'set-row-text'), control = element('div', undefined, 'set-row-control');
  const heading = element('p', title, 'set-row-title'), note = element('p', hint ?? '', 'set-row-hint'); note.hidden = !hint;
  text.append(heading, note); control.append(...controls); control.hidden = controls.length === 0;
  row.append(text, control);
  return { row, heading, note, control };
}
const smallButton = (label: string, tone: 'secondary' | 'ghost' = 'secondary') => element('button', label, `btn btn-${tone} btn-sm`);
const pathValue = (text: string) => {
  const value = element('span', undefined, 'set-row-value'); value.append(createIcon('folder', 14), element('span', text)); return value;
};
/**
 * The runtime view of saving: where saves go and whether suggestions are paused (top of History), the default
 * folder (Saving), and the spending limit (AI suggestions). The worker owns every change; this only asks.
 */
export function createCaptureControlView(host: HTMLElement) {
  const controls = host.querySelector<HTMLElement>('[data-capture-controls]')!;
  const settings = host.querySelector<HTMLElement>('[data-capture-authorization]')!;
  const defaultSettings = host.querySelector<HTMLElement>('[data-capture-default-target]')!;
  const behavior = host.querySelector<HTMLElement>('#classification-behavior');
  let version = 0, active = false, suggesting = false, view: CaptureRuntimeView | undefined, editing = false;
  // History top: one row for the destination, and rows that only appear when there is something to act on.
  const pause = smallButton('', 'ghost'); pause.type = 'button'; pause.hidden = true;
  const change = element('a', t('shell_change', 'Change'), 'btn btn-ghost btn-sm'); change.href = '#saving';
  const where = element('span', undefined, 'set-row-value');
  const saves = settingsRow(t('capture_savesGo', 'Saves go to'), undefined, where, change);
  const review = element('a', t('shell_review', 'Review'), 'btn btn-secondary btn-sm'); review.href = '#history?status=progress'; review.hidden = true;
  const suggestions = settingsRow(t('history_folderSuggestions', 'Folder suggestions'), undefined, review, pause); suggestions.note.setAttribute('role', 'status'); suggestions.row.hidden = true;
  controls.append(saves.row, suggestions.row); controls.hidden = true;
  let statusText = '', summary = '';
  const status = suggestions.note;
  document.addEventListener('known:capture-preferences-changed', () => { if (active) void refresh(); });
  window.addEventListener('focus', () => { if (active && !editing) void refresh(); });
  window.addEventListener('online', () => { if (active && !editing) void refresh(); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (active && !editing && area === 'local' && (changes[LOCAL_CLASSIFICATION_ENABLED] || changes[LOCAL_CLASSIFICATION_KEY])) void refresh();
  });
  pause.addEventListener('click', () => { if (!view) return; void mutate({ kind: 'known.capture.control.change', action: view.control.paused ? 'resume' : 'pause' }); });
  async function mutate(fields: Record<string, unknown>, expected = view) {
    if (!view || !expected || view.scopeKey !== expected.scopeKey) return false;
    const current = version, scopeKey = expected.scopeKey, storageKey = `known.capture.control.pending.${scopeKey}`; pause.disabled = true;
    setStatus(t('capture_savingBrowsersControl', 'Saving this browser’s control…'));
    try {
      const stored = (await chrome.storage.local.get(storageKey))[storageKey] as { fields: Record<string, unknown>; message: Record<string, unknown> } | undefined;
      if (stored && JSON.stringify(stored.fields) !== JSON.stringify(fields)) throw new Error('previous_control_result_unknown');
      const intent = stored ?? { fields, message: { ...fields, commandId: crypto.randomUUID(), generation: expected.control.generation, scopeKey } };
      await chrome.storage.local.set({ [storageKey]: intent });
      const result = await chrome.runtime.sendMessage(intent.message) as CaptureRuntimeView | { ok: false; error: string };
      if (current !== version) return false;
      if (!result?.ok) {
        if (result && ['capture_control_conflict', 'capture_scope_changed', 'credit_price_changed', 'insufficient_credits', 'target_not_mapped'].includes(result.error)) await chrome.storage.local.remove(storageKey);
        status.dataset.error = result?.error ?? 'control_unavailable';
        throw new Error(result?.error);
      }
      await chrome.storage.local.remove(storageKey); view = result; status.removeAttribute('data-error'); setStatus(''); paint(); return true;
    } catch { if (current === version) setStatus(t('capture_changeNotConfirmedDraft', 'Change is not confirmed. Your draft is retained; refresh the status before retrying.')); return false; }
    finally { pause.disabled = false; }
  }
  function paintNote() { const text = statusText || summary; status.textContent = text; status.hidden = text === ''; suggestions.row.hidden = !suggesting && statusText === ''; }
  function setStatus(text: string) { statusText = text; paintNote(); }
  function paint() {
    if (!view) return;
    controls.hidden = false;
    saves.note.hidden = true;
    where.replaceChildren();
    if (view.target) {
      where.append(createIcon('folder', 14), element('span', `${view.target.collectionTitle ? `${view.target.collectionTitle} › ` : ''}${view.target.path.join(' › ')}`));
      // Outside the sync scope only matters once there is an account to sync with.
      if (view.signedIn && !view.target.inRange) { const badge = element('span', FIRST_RUN_LOCAL_ONLY, 'badge'); badge.dataset.tone = 'warning'; where.append(badge); }
    } else where.textContent = view.targetError ?? t('capture_bookmarkPermissionRequiredRead', 'Bookmark permission is required to read the default target.');
    suggesting = view.mode === 'automatic' && view.classificationState !== 'off';
    pause.textContent = view.control.paused ? t('history_resumeSuggestions', 'Resume') : t('common_pause', 'Pause');
    pause.setAttribute('aria-label', view.control.paused ? t('capture_resumeBrowsersClassification', 'Resume this browser’s classification') : t('capture_pauseBrowsersClassification', 'Pause this browser’s classification'));
    pause.hidden = !suggesting;
    // "2 waiting · 1 to review", or why there is nothing to say: paused, or the state the worker reports.
    const parts: string[] = [];
    if (view.counts.resumable) parts.push(t('history_nWaiting', '$1 waiting', view.counts.resumable));
    if (view.counts.suggestions) parts.push(t('history_nToReview', '$1 to review', view.counts.suggestions));
    if (view.counts.checking) parts.push(t('history_nToCheck', '$1 to check', view.counts.checking));
    summary = view.control.paused ? t('history_suggestionsPaused', 'Paused') : parts.length ? parts.join(' · ')
      : view.classificationState === 'automatic' ? t('history_suggestionsReady', 'Ready') : CAPTURE_RUNTIME_COPY[view.classificationState] ?? view.classificationState;
    review.hidden = !suggesting || !(view.counts.suggestions || view.counts.checking);
    suggestions.control.hidden = pause.hidden && review.hidden;
    paintNote();
  }
  async function refresh() {
    const current = ++version;
    try {
      const result = await chrome.runtime.sendMessage({ kind: 'known.capture.control' }) as CaptureRuntimeView;
      if (current !== version || !active) return;
      if (!result?.ok) throw new Error();
      if (view && view.scopeKey !== result.scopeKey) { settings.replaceChildren(); defaultSettings.replaceChildren(); editing = false; }
      view = result; paint(); if (!editing) paintSettings();
      const storageKey = `known.capture.control.pending.${view.scopeKey}`;
      const pending = (await chrome.storage.local.get(storageKey))[storageKey] as { message?: { commandId?: string; generation?: number }; fields?: Record<string, unknown> } | undefined;
      if (current !== version) return;
      if (pending?.message?.commandId && pending.message.commandId === view.control.lastCommand?.id) { await chrome.storage.local.remove(storageKey); status.removeAttribute('data-error'); setStatus(t('capture_previousChangeConfirmed', 'The previous change is confirmed.')); }
      else if (pending?.fields) {
        status.dataset.error = 'previous_control_result_unknown';
        setStatus(t('capture_previousControlChangeHas', 'A previous control change has no confirmed result.'));
        const retry = smallButton(t('capture_checkPreviousControlChange', 'Check previous control change'));
        retry.type = 'button'; retry.addEventListener('click', () => { void mutate(pending.fields!).then(saved => { if (saved) retry.remove(); }); }); suggestions.control.append(retry); suggestions.control.hidden = false;
      }
    } catch {
      if (current !== version) return;
      const unread = t('capture_browsersStatusCouldNot', 'This browser’s status could not be read. Reopen this view to retry.');
      controls.hidden = false; saves.note.textContent = unread; saves.note.hidden = false;
      // The Saving and AI cards say so too, instead of showing an empty card.
      for (const card of [settings, defaultSettings]) if (!card.children.length) card.replaceChildren(settingsRow(unread).row);
    }
  }
  function paintSettings() {
    if (!view) return;
    // Default folder (Saving): the path and a Change button; the folder picker opens as its own row below.
    const folderButton = smallButton(view.permission ? t('shell_change', 'Change') : t('shell_allow', 'Allow'));
    folderButton.type = 'button';
    const folder = settingsRow(t('capture_defaultFolderSetting', 'Default folder'), t('shell_defaultFolderHint', 'Used when you don’t pick a folder.'),
      view.permission && view.target ? pathValue(view.target.path.join(' › ')) : element('span', view.permission ? t('capture_bookmarkPermissionRequiredRead', 'Bookmark permission is required to read the default target.') : t('shell_bookmarkAccessOff', 'Bookmark access is off'), 'set-row-value'), folderButton);
    defaultSettings.replaceChildren(folder.row);
    folderButton.addEventListener('click', () => {
      if (view?.permission) void chooseFolder();
      else void chrome.permissions.request({ permissions: ['bookmarks'] }).then(granted => {
        if (granted) location.reload();
        else folder.note.textContent = t('capture_permissionNotGrantedNo', 'Permission was not granted. No bookmark was created.');
      });
    });
    const suggestionsAvailable = Boolean(view.local || view.signedIn && view.target?.collectionId && view.target.inRange);
    if (behavior) behavior.hidden = !suggestionsAvailable;
    // The Saving page's suggestion rows (form-open suggestions, tags) appear with them.
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('[data-ai-only]'))) row.toggleAttribute('data-ai-off', !suggestionsAvailable);
    // Spending limit (AI suggestions, Know-N source).
    const consent = view.control.consent, expired = Boolean(consent && consent.expiresAt <= Date.now());
    const dateText = consent ? new Date(consent.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const reason = !view.permission ? t('capture_bookmarkPermissionRequired', 'Bookmark permission required')
      : view.local ? t('shell_localNoCredits', 'Your own AI service is in use. No credits are spent.')
        : !view.signedIn ? t('capture_signBeforeAuthorizingClassification', 'Sign in to use Know-N suggestions.')
          : !view.target?.collectionId || !view.target.inRange ? t('capture_chooseLibraryFolder', 'Choose a folder in your bookmark library first.')
            : '';
    const hint = reason || (!consent ? t('shell_noSpendingLimit', 'Not set. Know-N won’t spend credits on suggestions until you set a limit.')
      : expired ? t('shell_spendingLimitEnded', 'Your spending limit has ended. Suggestions pause until you set a new one.')
        : t('shell_spendingLimitHint', 'Up to $1 credits per save and $2 per day, until $3.', consent.maxPoints, consent.periodPoints, dateText));
    const authorize = smallButton(consent ? t('shell_change', 'Change') : t('shell_setLimit', 'Set limit'));
    authorize.type = 'button'; authorize.disabled = Boolean(reason);
    authorize.addEventListener('click', () => { void authorizationForm(); });
    // Signed out, the row offers the one thing that unblocks it instead of a disabled button.
    const signIn = element('a', t('common_signIn', 'Sign in'), 'btn btn-secondary btn-sm'); signIn.href = '#account';
    settings.replaceChildren(settingsRow(t('shell_spendingLimit', 'Spending limit'), hint, ...(view.local || !view.permission ? [] : [view.signedIn ? authorize : signIn])).row);
  }
  async function chooseFolder() {
    if (!view || editing) return;
    editing = true;
    const currentView = await chrome.runtime.sendMessage({ kind: 'known.capture.control' }).catch(() => null) as CaptureRuntimeView | null;
    if (!currentView?.ok || currentView.scopeKey !== view.scopeKey) { editing = false; setStatus(t('capture_activeAccountCollectionChanged', 'The account or library changed. Refresh settings.')); return; }
    view = currentView; paint(); const current = version, bound = view;
    const form = element('form', undefined, 'set-row set-row--stack'), field = element('div', undefined, 'set-field');
    const label = element('label', t('capture_defaultFolderBrowser', 'Default folder on this browser')), select = element('select', undefined, 'select-quiet'); select.id = 'capture-default-folder'; label.htmlFor = select.id;
    field.append(label, select); form.append(field); defaultSettings.append(form);
    try {
      const roots = await chrome.bookmarks.getTree(), excluded = await exclusionIds(); if (current !== version) return;
      for (const folder of folderChoices(roots, { exclude: excluded })) {
        if (folder.disabled) continue;
        const option = element('option', folder.path.join(' › ')); option.value = folder.id; select.append(option);
      }
      select.value = view.target?.nativeId ?? '';
      formButtons(form, async () => mutate({ kind: 'known.capture.control.target', nativeId: select.value }, bound));
    } catch { form.append(element('p', t('capture_foldersCouldNotRead', 'Folders could not be read. Reload after granting bookmark access.'), 'set-row-hint')); editing = false; }
  }
  async function authorizationForm() {
    if (!view || editing) return;
    editing = true;
    const currentView = await chrome.runtime.sendMessage({ kind: 'known.capture.control' }).catch(() => null) as CaptureRuntimeView | null;
    if (!currentView?.ok || currentView.scopeKey !== view.scopeKey) { editing = false; setStatus(t('capture_activeAccountCollectionChanged', 'The account or library changed. Refresh settings.')); return; }
    view = currentView; paint(); const current = version, bound = view, form = element('form', undefined, 'set-row set-row--stack set-fields'), message = element('p', t('capture_checkingCurrentPrice', 'Checking current price…'), 'set-row-hint'); message.setAttribute('role', 'status'); form.append(message); settings.append(form);
    try {
      const result = await chrome.runtime.sendMessage({ kind: 'known.capture.control.quote' }) as { ok: boolean; quote: { priceVersion: string; unitPoints: number; available: number } };
      if (current !== version) return; if (!result?.ok) throw new Error();
      message.textContent = t('capture_currentPriceUpCredits', 'Up to $1 credits per suggestion. $2 available. The limit lasts 24 hours.', result.quote.unitPoints, result.quote.available);
      const field = (id: string, text: string, value: number) => {
        const wrapper = element('div', undefined, 'set-field'), label = element('label', text), input = element('input', undefined, 'field-quiet');
        label.htmlFor = input.id = id; input.type = 'number'; input.min = String(result.quote.unitPoints); input.max = '2147483647'; input.step = '1'; input.required = true; input.value = String(value);
        wrapper.append(label, input); form.append(wrapper); return input;
      };
      const max = field('capture-single-cap', t('capture_maximumCreditsPerCapture', 'Maximum credits per save'), result.quote.unitPoints), period = field('capture-period-cap', t('capture_maximumCredits24Hours', 'Maximum credits in 24 hours'), Math.max(result.quote.unitPoints, view.control.consent?.periodPoints ?? result.quote.unitPoints));
      formButtons(form, () => mutate({ kind: 'known.capture.control.authorize', collectionId: bound.target!.collectionId,
        priceVersion: result.quote.priceVersion, maxPoints: Number(max.value), periodPoints: Number(period.value) }, bound));
    } catch { message.textContent = t('capture_priceCouldNotConfirmed', 'Price could not be confirmed. No authorization was saved.'); editing = false; }
  }
  function formButtons(form: HTMLFormElement, save: () => Promise<boolean>) {
    const submit = element('button', t('capture_saveBrowsersSettings', 'Save this browser’s settings'), 'btn btn-primary btn-sm'), cancel = element('button', t('common_cancel', 'Cancel'), 'btn btn-secondary btn-sm'); submit.type = 'submit'; cancel.type = 'button';
    const buttons = element('div', undefined, 'set-row-control'); buttons.append(submit, cancel); form.append(buttons);
    cancel.addEventListener('click', () => { editing = false; form.remove(); paintSettings(); });
    form.addEventListener('submit', event => { event.preventDefault(); submit.disabled = true;
      void save().then(saved => { if (saved) { editing = false; paintSettings(); } }).finally(() => { submit.disabled = false; }); });
  }
  return { activate() { active = true; return refresh(); }, deactivate() { active = false; version++; },
    clear() { active = false; version++; editing = false; view = undefined; settings.replaceChildren(); defaultSettings.replaceChildren(); controls.hidden = true; where.replaceChildren(); suggestions.row.hidden = true; statusText = summary = ''; } };
}

export async function confirmAutomaticMode(): Promise<boolean> {
  const result = await chrome.runtime.sendMessage({ kind: 'known.capture.control' }).catch(() => null) as CaptureRuntimeView | null;
  const accepted = await new Promise<boolean>(resolve => {
    const { dialog, body, actions } = createDialog(t('capture_enableAutomaticCapture', 'Enable automatic capture'));
    body.append(element('p', t('capture_defaultTargetOnlyActive', 'Saves go to $1. Only your clicks save pages; existing bookmarks stay as they are.', result?.target?.path.join(' › ') ?? t('capture_chooseLocalFolderSettings', 'Choose a local folder in settings'))),
      element('p', t('capture_pagesSaveBrowserFirst', 'Pages save straight into this browser’s bookmarks. No account or AI service is needed.')));
    const cancel = dialogButton(t('common_cancel', 'Cancel')), confirm = dialogButton(t('capture_saveAutomaticMode', 'Save automatic mode'), 'primary');
    let accepted = false; cancel.addEventListener('click', () => dialog.close()); confirm.addEventListener('click', () => { accepted = true; dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }); actions.append(cancel, confirm); document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
  if (!accepted) return false;
  const current = await chrome.runtime.sendMessage({ kind: 'known.capture.control' }).catch(() => null) as CaptureRuntimeView | null;
  return Boolean(current?.ok && result?.ok && current.scopeKey === result.scopeKey);
}
