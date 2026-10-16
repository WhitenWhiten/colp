import { sharedManagerMenu } from './bookmark-manager-menu.js';
import { localized, t, tn } from './i18n.js';
import { createIcon } from './icons.js';
import { el, iconButton } from './library-dom.js';
/**
 * S1 / B0-1 (SR-01): the options-page exit for `native_result_unknown`.
 *
 * The card is rendered from `known.nativeWait.list` and every decision goes
 * through `known.nativeWait.confirm` with `userGesture: true`. The copy is
 * deliberately explicit about the blast radius: while a wait is open the
 * inbound path (Pull/Ack) is parked, uploads are not, and "Don't place this
 * cloud item on this device" gives up the local landing of that remote node only.
 */
import type {
  NativeWaitConfirmAction, NativeWaitConfirmRequest, NativeWaitRequest, NativeWaitResponse, PublicNativeWait,
  PublicNativeWaitCandidate,
} from './types.js';

export const NATIVE_WAIT_ANCHOR = 'native-wait-settings';
export const NATIVE_WAIT_OPTIONS_PATH = `options.html#${NATIVE_WAIT_ANCHOR}`;
export let NATIVE_WAIT_BIND_LABEL: string, NATIVE_WAIT_KEEP_LOCAL_LABEL: string, NATIVE_WAIT_CANCEL_LABEL: string, NATIVE_WAIT_LINK_LABEL: string, NATIVE_WAIT_NATIVE_ID_PLACEHOLDER: string, NATIVE_WAIT_NATIVE_ID_REQUIRED: string;
localized(() => {
  NATIVE_WAIT_BIND_LABEL = t('nativeWait_useBookmarkAlreadyDevice', 'Use a bookmark already on this device');
  NATIVE_WAIT_KEEP_LOCAL_LABEL = t('nativeWait_keepDeviceCreateNew', 'Keep on this device and create a new one');
  NATIVE_WAIT_CANCEL_LABEL = t('nativeWait_dontPlaceCloudItem', "Don't place this cloud item on this device");
  NATIVE_WAIT_LINK_LABEL = t('nativeWait_viewItemsWaitingConfirmation', 'View items waiting for confirmation');
  NATIVE_WAIT_NATIVE_ID_PLACEHOLDER = t('nativeWait_noMatchingLocalBookmarks', 'No matching local bookmarks');
  NATIVE_WAIT_NATIVE_ID_REQUIRED = t('nativeWait_chooseBookmarkUse', 'Choose the bookmark to use.');
});

const WAIT_REFRESH_MS = 8_000;
const ACTIONS: readonly NativeWaitConfirmAction[] = ['bind', 'keep_local_and_create', 'cancel'];

export function nativeWaitIntroCopy(): string {
  return t('nativeWait_intro', 'Incoming sync pauses until you decide; uploads continue. “Don’t place” keeps the item in your collection but not on this browser.');
}

/** The alert line over the Status page while items wait. */
export function nativeWaitSummaryCopy(count: number): string {
  return tn('sync_waitSummary', count, '$1 bookmark from Know-N needs your decision before it’s added here.', '$1 bookmarks from Know-N need your decision before they’re added here.');
}

export function nativeWaitActionLabel(action: NativeWaitConfirmAction): string {
  return action === 'bind' ? NATIVE_WAIT_BIND_LABEL
    : action === 'keep_local_and_create' ? NATIVE_WAIT_KEEP_LOCAL_LABEL : NATIVE_WAIT_CANCEL_LABEL;
}

/** The short word on a row's button; the long sentence stays as its tooltip and accessible name. */
export function nativeWaitShortLabel(action: NativeWaitConfirmAction): string {
  return action === 'bind' ? t('sync_useExisting', 'Use existing')
    : action === 'keep_local_and_create' ? t('sync_keepBoth', 'Keep both') : t('sync_dontPlace', "Don't place");
}

/** What a waiting bookmark is called: its title, else its address, else a plain stand-in. */
export function nativeWaitTitleCopy(wait: PublicNativeWait): string {
  return wait.title || wait.url || t('nativeWait_bookmarkWaiting', 'Bookmark waiting for confirmation');
}

/** The line under the title: where it lives and why it waits. */
export function nativeWaitDetailCopy(wait: PublicNativeWait): string {
  const reason = nativeWaitReasonCopy(wait.waitReason);
  return wait.title && wait.url ? `${hostOf(wait.url)} · ${reason}` : reason;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname || url; } catch { return url; }
}

export function nativeWaitReasonCopy(reason: PublicNativeWait['waitReason']): string {
  return reason === 'waiting_dependency'
    ? t('nativeWait_waitingParentFolder', 'Waiting for the parent folder')
    : t('nativeWait_browserCreatedBookmarkBut', 'This browser created the bookmark, but the result was not recorded');
}

export function nativeWaitTargetCopy(wait: PublicNativeWait): string {
  const reason = nativeWaitReasonCopy(wait.waitReason);
  if (wait.title || wait.url) {
    const main = wait.title && wait.url ? `${wait.title} (${wait.url})` : (wait.title || wait.url);
    return `${main} · ${reason}`;
  }
  return t('nativeWait_bookmarkWaitingConfirmation', 'Bookmark waiting for confirmation · $1', reason);
}

export function nativeWaitCandidateLabel(candidate: PublicNativeWaitCandidate): string {
  const named = candidate.title?.trim();
  const url = candidate.url?.trim();
  if (named && url) return `${named} (${url})`;
  return named || url || t('nativeWait_bookmarkDevice', 'Bookmark on this device');
}

export function nativeWaitResultCopy(result: 'bound' | 'kept_local' | 'cancelled' | 'duplicate'): string {
  if (result === 'bound') return t('nativeWait_boundExistingBookmark', 'Bound to an existing bookmark.');
  if (result === 'kept_local') return t('nativeWait_keptLocalBookmarkCreated', 'Kept the local bookmark and created a new one.');
  if (result === 'cancelled') return t('nativeWait_cancelledCloudItemWill', 'Cancelled: this cloud item will not be placed on this device.');
  return t('nativeWait_itemAlreadyHandledNo', 'This item was already handled. No further confirmation is needed.');
}

/** Every refusal reads as a sentence; a code nobody can act on is never shown. */
export function nativeWaitFeedbackCopy(code: string): string {
  if (code === 'stale_ref') return t('nativeWait_itemChangedRefreshTry', 'This item changed. Refresh and try again.');
  if (code === 'generation_mismatch') return t('nativeWait_syncIdentityUpdatedReopen', 'Sync identity was updated. Reopen settings.');
  if (code === 'account_switch') return t('nativeWait_syncAccountChangedReopen', 'The sync account changed. Reopen settings.');
  if (code === 'detached') return t('nativeWait_deviceLeftSync', 'This device left sync.');
  if (code === 'revoked' || code === 'permission_required') return t('nativeWait_bookmarkPermissionRequiredConfirm', 'Bookmark permission is required to confirm this item.');
  if (code === 'native_result_cas') return t('nativeWait_itemAlreadyHandledRefresh', 'This item was already handled. Refresh the list.');
  if (code === 'intent_not_found') return t('nativeWait_syncItemCouldNot', 'That sync item could not be found.');
  if (code === 'request_invalid') return t('nativeWait_couldNotConfirmItem', 'Could not confirm this item: matching details are missing.');
  if (code === 'not_connected') return t('nativeWait_notSignedSyncAccount', 'Not signed in to a sync account.');
  if (code === 'extension_unavailable') return t('nativeWait_extensionBackgroundTemporarilyUnavailable', 'The extension background is temporarily unavailable. Try again.');
  return t('nativeWait_couldNotCompleteAction', 'Could not complete this action. Try again.');
}

export function nativeWaitConfirmRequest(wait: PublicNativeWait, action: NativeWaitConfirmAction,
  nativeId?: string): NativeWaitConfirmRequest {
  return {
    kind: 'known.nativeWait.confirm', userGesture: true, waitRef: wait.waitRef, intentId: wait.intentId,
    generation: wait.generation, action,
    ...(action === 'bind' && nativeId ? { nativeId } : {}),
  };
}

export function isNativeWaitDeepLink(hash: string): boolean {
  return hash.replace(/^#/u, '') === NATIVE_WAIT_ANCHOR;
}

export function bindNativeWaitSettings(): void {
  const host = document.getElementById(NATIVE_WAIT_ANCHOR);
  if (!host) return;
  const intro = required('native-wait-intro');
  const list = required('native-wait-list');
  const feedback = required('native-wait-feedback');
  const summary = required('sync-summary');
  const summaryCopy = required('sync-summary-copy');
  const template = required('native-wait-item') as HTMLTemplateElement;
  intro.textContent = nativeWaitIntroCopy();
  required('sync-summary-review').addEventListener('click', () => {
    host.scrollIntoView({ block: 'start' });
    list.querySelector<HTMLElement>('button')?.focus();
  });
  let busy = false;

  const refresh = async (force = false): Promise<void> => {
    if (!force && (busy || list.contains(document.activeElement) || list.querySelector('.native-wait-cancel-confirm'))) return;
    const response = await send({ kind: 'known.nativeWait.list' });
    if (response.ok === false) { showFeedback(feedback, nativeWaitFeedbackCopy(response.code)); return; }
    if (!('waits' in response)) { showFeedback(feedback, nativeWaitFeedbackCopy('request_invalid')); return; }
    if (!force && (busy || list.contains(document.activeElement) || list.querySelector('.native-wait-cancel-confirm'))) return;
    feedback.hidden = true; feedback.textContent = '';
    const waits = response.waits;
    // With nothing waiting there is nothing to read here: the group and its summary step aside.
    host.hidden = waits.length === 0;
    summary.hidden = waits.length === 0;
    summaryCopy.textContent = waits.length === 0 ? '' : nativeWaitSummaryCopy(waits.length);
    list.replaceChildren();
    try {
      for (const wait of waits) list.append(renderWait(wait, template, feedback, (action, nativeId) =>
        decide(wait, action, nativeId)));
    } catch { showFeedback(feedback, nativeWaitFeedbackCopy('native_wait_render_failed')); }
  };

  const decide = async (wait: PublicNativeWait, action: NativeWaitConfirmAction,
    nativeId?: string): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const response = await send(nativeWaitConfirmRequest(wait, action, nativeId));
      if (response.ok === false) { showFeedback(feedback, nativeWaitFeedbackCopy(response.code)); }
      else if (!('result' in response)) { showFeedback(feedback, nativeWaitFeedbackCopy('request_invalid')); }
      else {
        showFeedback(feedback, nativeWaitResultCopy(response.result), 'info');
      }
    } finally { busy = false; }
    host.tabIndex = -1; host.focus({ preventScroll: true });
    await refresh(true);
  };

  list.addEventListener('focusout', () => { setTimeout(() => { void refresh(); }, 150); });
  void refresh();
  reflectDeepLink(host);
  queueMicrotask(() => reflectDeepLink(host));
  window.addEventListener('hashchange', () => {
    reflectDeepLink(host);
    if (isNativeWaitDeepLink(location.hash) || location.hash.startsWith('#sync')) void refresh();
  });
  setInterval(() => { if (document.body.dataset.pane === 'sync') void refresh(); }, WAIT_REFRESH_MS);
}

/**
 * One waiting bookmark: its name and why it waits, at most two buttons on the
 * row, and the destructive choice in the ⋯ menu behind a confirmation.
 */
function renderWait(wait: PublicNativeWait, template: HTMLTemplateElement, feedback: HTMLElement,
  decide: (action: NativeWaitConfirmAction, nativeId?: string) => Promise<void>): HTMLElement {
  const row = template.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
  if (!row) throw new Error('native_wait_template_invalid');
  row.dataset.syncItem = wait.intentId; row.dataset.syncNode = wait.colpId;
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('bookmark', 16));
  row.prepend(tile);
  const target = row.querySelector('.native-wait-target');
  if (target) { target.textContent = nativeWaitTitleCopy(wait); if (wait.url) target.setAttribute('title', wait.url); }
  const reason = row.querySelector('.native-wait-reason');
  if (reason) reason.textContent = nativeWaitDetailCopy(wait);
  const readChoice = choiceReader(row, wait);
  const controls = row.querySelector<HTMLElement>('.set-row-control');
  for (const action of ACTIONS) {
    const button = row.querySelector<HTMLButtonElement>(`[data-native-wait-action="${action}"]`);
    if (!button) continue;
    if (action === 'bind' && wait.candidates.length === 0) {
      button.hidden = true;
      continue;
    }
    button.textContent = nativeWaitShortLabel(action);
    button.title = nativeWaitActionLabel(action);
    button.setAttribute('aria-label', nativeWaitActionLabel(action));
    button.addEventListener('click', () => {
      const nativeId = action === 'bind' ? readChoice() : undefined;
      if (action === 'bind' && !nativeId) { showFeedback(feedback, NATIVE_WAIT_NATIVE_ID_REQUIRED); return; }
      void decide(action, nativeId);
    });
  }
  const more = iconButton('more-horizontal', t('common_moreActions', 'More actions'));
  more.addEventListener('click', () => {
    const rect = more.getBoundingClientRect();
    sharedManagerMenu().openAt(rect.right - 176, rect.bottom + 4, [{
      label: nativeWaitActionLabel('cancel'), tone: 'danger',
      run: () => showCancelConfirmation(row, () => { void decide('cancel'); }),
    }], more);
  });
  controls?.append(more);
  return row;
}

function showCancelConfirmation(row: HTMLElement, onConfirm: () => void): void {
  const text = row.querySelector<HTMLElement>('.set-row-text');
  const controls = row.querySelector<HTMLElement>('.set-row-control');
  if (!text || !controls || row.querySelector('.native-wait-cancel-confirm')) return;
  controls.hidden = true;
  const wrap = el('div', undefined, 'native-wait-cancel-confirm');
  const note = el('p', t('nativeWait_dontPlaceCloudItem2', "Don't place this cloud item on this device? The cloud bookmark will stay in your collection, but won't be added to this browser. To sync it later, edit the bookmark in Know-N."));
  const actions = el('div', undefined, 'confirm-actions');
  const keep = el('button', t('common_keepItem', 'Keep item'), 'btn btn-ghost btn-sm'); keep.type = 'button';
  keep.addEventListener('click', () => { wrap.remove(); controls.hidden = false; controls.querySelector('button')?.focus(); });
  const confirm = el('button', t('common_dontPlace', "Don't place"), 'btn btn-danger btn-sm'); confirm.type = 'button';
  confirm.addEventListener('click', onConfirm);
  actions.append(keep, confirm); wrap.append(note, actions); text.append(wrap);
  keep.focus();
}

/** Candidate picker when the projection produced one, informative note otherwise. */
function choiceReader(row: HTMLElement, wait: PublicNativeWait): () => string | undefined {
  const host = row.querySelector('.native-wait-choice');
  if (!host) return () => undefined;
  host.replaceChildren();
  if (wait.candidates.length > 0) {
    const select = el('select', undefined, 'select-quiet native-wait-candidate');
    select.setAttribute('aria-label', NATIVE_WAIT_BIND_LABEL);
    for (const candidate of wait.candidates) {
      const option = el('option', nativeWaitCandidateLabel(candidate));
      option.value = candidate.nativeId;
      select.append(option);
    }
    host.append(el('span', t('sync_existingBookmark', 'Existing bookmark'), 'set-row-hint'), select);
    return () => select.value || undefined;
  }
  host.append(el('span', t('nativeWait_noMatchingLocalBookmarks2', 'No matching local bookmarks found.'), 'set-row-hint'));
  return () => undefined;
}

function reflectDeepLink(host: HTMLElement): void {
  const linked = isNativeWaitDeepLink(location.hash);
  host.classList.toggle('native-wait-highlight', linked);
  if (linked) host.scrollIntoView({ block: 'center' });
}

function showFeedback(node: HTMLElement, text: string, tone: 'info' | 'warning' = 'warning'): void {
  node.hidden = false;
  node.textContent = text;
  const box = node.parentElement;
  if (box?.classList.contains('inline-alert')) { if (tone === 'info') delete box.dataset.tone; else box.dataset.tone = 'warning'; }
}

/** Whatever comes back is a refusal with a readable code, never a half-shaped object. */
async function send(message: NativeWaitRequest): Promise<NativeWaitResponse> {
  try {
    const pending = chrome.runtime.sendMessage(message) as Promise<unknown>;
    const timeout = new Promise<NativeWaitResponse>((resolve) => {
      setTimeout(() => resolve({ ok: false, code: 'extension_unavailable' }), 8_000);
    });
    return normalize(await Promise.race([pending, timeout]));
  } catch { return { ok: false, code: 'extension_unavailable' }; }
}

function normalize(value: unknown): NativeWaitResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return { ok: false, code: 'extension_unavailable' };
  const response = value as { ok: unknown; code?: unknown; error?: unknown };
  if (response.ok !== false) return value as NativeWaitResponse;
  const code = typeof response.code === 'string' ? response.code : typeof response.error === 'string' ? response.error : 'request_invalid';
  return { ok: false, code };
}

function required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing:${id}`);
  return node;
}
