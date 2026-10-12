import { confirmAutomaticMode } from './capture/control-view.js';
import type { BookmarkPreferencesResponse } from './types.js';
import type { AiTagMode, BookmarkPreferences } from './bookmark-preferences.js';
import { BOOKMARK_PREFERENCES_CACHE, effectiveAiTagMode } from './bookmark-preferences.js';
import { LOCAL_CLASSIFICATION_ENABLED, localClassificationRequested } from './classification-local-session.js';
import { onSwitch, setSwitch } from './toggle-switch.js';
import { showToast, type ToastTone } from './toast.js';
import { t } from './i18n.js';

/**
 * Saving, placement, suggestion-behaviour and subscription-default settings.
 * They live on different pages (Saving, AI suggestions, Subscriptions) but are
 * one preference record, so one controller reads and saves them all and reports
 * problems in one notice that the page holding the setting shows under its title.
 */
export function bindBookmarkPreferences(onChanged: (foldersFirst: boolean) => void = () => undefined) {
  const top = document.getElementById('bookmark-insert-top') as HTMLButtonElement;
  const bottom = document.getElementById('bookmark-insert-bottom') as HTMLButtonElement;
  const folders = document.getElementById('bookmark-folders-first') as HTMLButtonElement;
  const status = document.getElementById('bookmark-preferences-status') as HTMLElement;
  const useServer = document.getElementById('bookmark-preferences-use-server') as HTMLButtonElement;
  const useLocal = document.getElementById('bookmark-preferences-use-local') as HTMLButtonElement;
  if (!top || !bottom || !folders || !status || !useServer || !useLocal) return { refresh: async () => undefined };
  const notice = document.getElementById('bookmark-preferences-notice');
  const mode = document.getElementById('capture-mode') as HTMLSelectElement | null;
  const duration = document.getElementById('capture-panel-duration') as HTMLSelectElement | null;
  const learning = document.getElementById('capture-learning') as HTMLButtonElement | null;
  const resume = document.getElementById('capture-resume-online') as HTMLButtonElement | null;
  const conflictValues = document.getElementById('bookmark-preferences-conflict-values');
  const tagButtons = Array.from(document.getElementById('ai-tag-mode')?.querySelectorAll<HTMLButtonElement>('button[data-value]') ?? []);
  const tagHint = document.getElementById('ai-tag-mode-hint');
  const subscriptionFields = {
    subscriptionOnUnfollow: document.getElementById('subscription-on-unfollow'),
    subscriptionOnUnsubscribe: document.getElementById('subscription-on-unsubscribe'),
    subscriptionDefaultCheckIntervalMinutes: document.getElementById('subscription-default-interval'),
    subscriptionDefaultDigestMode: document.getElementById('subscription-default-mode'),
    subscriptionDefaultEditionLimit: document.getElementById('subscription-default-limit'),
  } as Record<string, HTMLSelectElement | HTMLInputElement | null>;
  let supportedSubscriptions = new Set<string>();
  const support = document.getElementById('subscription-preferences-support');
  const supportNotice = document.getElementById('subscription-preferences-notice');
  const limitField = document.getElementById('subscription-default-limit-field');
  const limitError = document.getElementById('subscription-limit-error');
  const showLimit = () => { if (limitField) limitField.hidden = subscriptionFields.subscriptionDefaultDigestMode?.value !== 'recent'; };
  for (const [key, control] of Object.entries(subscriptionFields)) control?.addEventListener('change', () => {
    if (!supportedSubscriptions.has(key)) return;
    let value: string | number | null = control.value;
    if (key === 'subscriptionDefaultEditionLimit') {
      value = Number(value);
      const valid = Number.isInteger(value) && value >= 1 && value <= 20;
      control.setAttribute('aria-invalid', String(!valid));
      if (limitError) limitError.textContent = valid ? t('prefs_most20ReadableIssues', 'At most 20 readable issues.') : t('subscription_limitHint', 'Choose a whole number from 1 to 20.');
      if (!valid) return;
    }
    if (key === 'subscriptionDefaultCheckIntervalMinutes') value = value === 'manual' ? null : Number(value);
    if (key === 'subscriptionDefaultDigestMode') showLimit();
    void save({ [key]: value });
  });
  /* Panel duration, "suggest when the Manual form opens" and "finish after reconnecting" only act in one
     mode, so their rows carry data-mode-only and follow the mode. */
  /* The visible control is a pair of choice cards; the hidden #capture-mode
     select stays the single source of truth this controller reads and saves. */
  const modeChoices = Array.from(document.querySelectorAll?.<HTMLInputElement>('input[name="capture-mode-choice"]') ?? []);
  const syncModeChoices = () => { for (const choice of modeChoices) { choice.checked = choice.value === mode?.value; choice.disabled = Boolean(mode?.disabled); } };
  const focusMode = () => { (modeChoices.find(choice => choice.checked) ?? mode)?.focus(); };
  for (const choice of modeChoices) choice.addEventListener('change', () => { if (!choice.checked || !mode) return; mode.value = choice.value; mode.dispatchEvent(new Event('change')); });
  const paintModeRows = () => {
    if (mode) for (const row of Array.from(document.querySelectorAll?.<HTMLElement>('[data-mode-only]') ?? [])) row.hidden = row.dataset.modeOnly !== mode.value;
    syncModeChoices();
    paintTagMode();
  };
  /* Tags from AI: Off / Suggest / Add. The hint says what the choice does in the current mode. */
  let shown: BookmarkPreferences | undefined, localAi = false;
  const tagModeHint = (value: AiTagMode, automatic: boolean): string => value === 'off' ? t('shell_tagModeOffHint', 'Suggestions pick a folder only.')
    : value === 'suggest' ? automatic ? t('shell_tagModeSuggestAutomaticHint', 'Shows up to 3 of your existing tags in the result panel. Click one to add it.')
      : t('shell_tagModeSuggestManualHint', 'Shows up to 3 of your existing tags under Tags. Click one to add it.')
      : automatic ? t('shell_tagModeAddAutomaticHint', 'Adds up to 3 of your existing tags to the saved bookmark. Remove any in the result panel.')
        : t('shell_tagModeAddManualHint', 'Adds up to 3 of your existing tags to the form. Remove any before you save.');
  function paintTagMode(): void {
    const value = effectiveAiTagMode(shown && { ...shown, captureMode: (mode?.value ?? shown.captureMode) as BookmarkPreferences['captureMode'] }, localAi);
    for (const button of tagButtons) { const on = button.dataset.value === value; button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1; }
    if (tagHint) tagHint.textContent = tagModeHint(value, mode?.value === 'automatic');
  }
  for (const [index, button] of tagButtons.entries()) {
    button.addEventListener('click', () => { if (button.getAttribute('aria-checked') !== 'true') void save({ aiTagMode: button.dataset.value as AiTagMode }); });
    button.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key, step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tagButtons[(index + step + tagButtons.length) % tagButtons.length]!;
      next.focus(); next.click();
    });
  }
  void localClassificationRequested().then(on => { localAi = on; paintTagMode(); }, () => undefined);
  paintModeRows();
  mode?.addEventListener('change', () => {
    const requested = mode.value as 'manual' | 'automatic';
    void (async () => {
      if (requested === 'automatic') {
        mode.disabled = true; syncModeChoices();
        const accepted = await confirmAutomaticMode(); mode.disabled = false; syncModeChoices();
        if (!accepted) { mode.value = 'manual'; paintModeRows(); focusMode(); return; }
      }
      paintModeRows();
      const saved = await save({ captureMode: requested });
      if (saved && requested === 'automatic') showToast(t('prefs_automaticModeHint', 'Open a webpage and click the extension to save to this browser. AI suggestions and sync are optional.'), 'info');
      focusMode();
    })();
  });
  duration?.addEventListener('change', () => { void save({ resultPanelAutoDismissMs: Number(duration.value) }); });
  onSwitch(learning, on => { void save({ learnFromCorrections: on }); });
  onSwitch(resume, on => { void save({ resumeClassificationWhenOnline: on }); });
  /* The conflict notice names values the way the settings do, never as stored codes ("top", true, 5000). */
  const plain = (key: string, value: unknown): string => {
    if (key === 'bookmarkInsertPosition') return value === 'top' ? t('shell_topOfFolder', 'Top of folder') : t('shell_bottomOfFolder', 'Bottom of folder');
    if (typeof value === 'boolean') return value ? t('shell_on', 'On') : t('shell_off', 'Off');
    if (key === 'captureMode') return value === 'automatic' ? t('capture_modeAutomatic', 'Automatic') : t('common_manual', 'Manual');
    if (key === 'aiTagMode') return tagButtons.find(button => button.dataset.value === value)?.textContent ?? String(value);
    const control = (key === 'resultPanelAutoDismissMs' ? duration : subscriptionFields[key]) as HTMLSelectElement | null | undefined;
    const wanted = value === null ? 'manual' : String(value);
    return Array.from(control?.options ?? []).find(option => option.value === wanted)?.textContent ?? String(value);
  };
  let requestVersion = 0;
  let currentConflict = false;
  let accountDefaults: BookmarkPreferences | undefined;
  let submitting = false;
  let refreshPending = false;
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[LOCAL_CLASSIFICATION_ENABLED]) { localAi = changes[LOCAL_CLASSIFICATION_ENABLED].newValue === true; paintTagMode(); }
    if (area !== 'local' || !changes[BOOKMARK_PREFERENCES_CACHE]) return;
    if (submitting) refreshPending = true;
    else void refresh(true);
  });

  /* Top/Bottom is a radiogroup of two buttons: one stop in the tab order, arrows move and select. */
  const position = [top, bottom];
  const checkedPosition = (): HTMLButtonElement | undefined => position.find(button => button.getAttribute('aria-checked') === 'true');
  const paintPosition = (value: string | undefined) => {
    for (const button of position) { const on = button.dataset.value === value; button.setAttribute('aria-checked', String(on)); button.tabIndex = on || !value && button === top ? 0 : -1; }
  };
  for (const button of position) {
    button.addEventListener('click', () => { if (button.getAttribute('aria-checked') !== 'true') void save({ bookmarkInsertPosition: button.dataset.value as 'top' | 'bottom' }); });
    button.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
      event.preventDefault();
      const next = button === top ? bottom : top;
      next.focus(); next.click();
    });
  }
  onSwitch(folders, on => { void save({ foldersFirst: on }); });
  useServer.addEventListener('click', () => { void (async () => {
    if (accountDefaults?.captureMode === 'automatic' && mode?.value !== 'automatic' && !await confirmAutomaticMode()) return;
    await resolve('server');
  })(); });
  useLocal.addEventListener('click', () => { void resolve('local'); });

  /** Toast reminder messages in the bottom-right corner instead of jumping the page header. */
  function say(text: string, tone?: 'danger' | 'warning'): void {
    status.textContent = text;
    if (text) {
      const toastTone: ToastTone = tone === 'danger' ? 'error' : 'info';
      showToast(text, toastTone, { announce: true });
    }
    if (notice) {
      notice.hidden = !currentConflict;
      if (tone) notice.dataset.tone = tone; else delete notice.dataset.tone;
    }
  }

  async function refresh(localOnly = false): Promise<void> {
    if (submitting) { refreshPending = true; return; }
    const version = ++requestVersion;
    const response = await request({ kind: localOnly ? 'known.bookmark.preferences.local' : 'known.bookmark.preferences.get' });
    if (version !== requestVersion) return;
    if (!response.ok) { if (!localOnly) say(t('shell_preferencesNotLoaded', 'Your saving preferences could not be loaded. Reload this page to try again.'), 'danger'); return; }
    paint(response);
  }

  function save(value: Partial<BookmarkPreferences>): Promise<boolean> {
    return write({ kind: 'known.bookmark.preferences.update', userGesture: true, ...value });
  }

  function resolve(choice: 'server' | 'local'): Promise<boolean> {
    return write({ kind: 'known.bookmark.preferences.resolve', userGesture: true, choice });
  }

  async function write(message: Parameters<typeof request>[0]): Promise<boolean> {
    const version = ++requestVersion;
    submitting = true;
    setBusy(true);
    const response = await request(message);
    submitting = false; setBusy(false);
    let saved = false;
    if (version === requestVersion) {
      if (response.ok) {
        paint(response); saved = true;
        if (!response.conflict && !response.pending) showToast(t('capture_savedBrowser', 'Saved for this browser.'), 'ok');
      } else say(t('prefs_notSavedChoiceRemains', 'Not saved. Your choice remains in the form; the effective preference has not changed.'), 'danger');
    }
    if (refreshPending) { refreshPending = false; await refresh(true); }
    return saved;
  }

  function paint(response: Extract<BookmarkPreferencesResponse, { ok: true }>): void {
    shown = response.preferences;
    paintPosition(response.preferences.bookmarkInsertPosition);
    setSwitch(folders, response.preferences.foldersFirst);
    if (mode) mode.value = response.preferences.captureMode ?? 'manual';
    paintModeRows();
    if (duration) duration.value = String(response.preferences.resultPanelAutoDismissMs ?? 3000);
    setSwitch(learning, response.preferences.learnFromCorrections ?? true);
    setSwitch(resume, response.preferences.resumeClassificationWhenOnline ?? true);
    supportedSubscriptions = new Set(Object.keys(subscriptionFields).filter(key => response.scope === 'account' && Object.prototype.hasOwnProperty.call(response.preferences, key)));
    for (const [key, control] of Object.entries(subscriptionFields)) {
      if (!control) continue;
      const value = response.preferences[key as keyof BookmarkPreferences];
      control.disabled = !supportedSubscriptions.has(key) || response.conflict;
      if (supportedSubscriptions.has(key)) control.value = value === null ? 'manual' : String(value);
    }
    showLimit();
    if (support) {
      const loaded = response.scope === 'account' && supportedSubscriptions.size >= 5 && !response.pending && !response.conflict;
      support.textContent = response.scope !== 'account' ? t('prefs_signChangeAccountSubscription', 'Sign in to change account subscription preferences.')
        : supportedSubscriptions.size < 5 ? t('prefs_subscriptionPreferencesNotFully', 'Subscription preferences are not fully supported by this server. Missing settings cannot be changed.')
          : response.pending || response.conflict ? t('prefs_exitPolicyChangesNot', 'Exit policy changes are not confirmed. Resolve or sync before an exit.') : t('prefs_accountDefaultsLoadedChanges', 'Account defaults loaded. Changes save automatically.');
      // Loaded is the normal case and needs no words.
      if (supportNotice) supportNotice.hidden = loaded;
    }
    if (conflictValues) {
      conflictValues.replaceChildren(); conflictValues.hidden = !response.conflictValues;
      const labels: Record<string, string> = { bookmarkInsertPosition: t('common_savePosition', 'Save position'), foldersFirst: t('common_foldersFirst', 'Folders first'),
        captureMode: t('common_captureMode', 'Capture mode'), resultPanelAutoDismissMs: t('prefs_resultPanelDuration', 'Result panel duration'),
        subscriptionOnUnfollow: t('subscription_afterUnfollow', 'When you unfollow'), subscriptionOnUnsubscribe: t('subscription_afterUnsubscribe', 'When you unsubscribe'),
        subscriptionDefaultCheckIntervalMinutes: t('prefs_defaultCheckInterval', 'Default check interval'), subscriptionDefaultDigestMode: t('prefs_defaultDigestContent', 'Default Digest content'), subscriptionDefaultEditionLimit: t('prefs_defaultRecentIssueCount', 'Default recent issue count'),
        learnFromCorrections: t('prefs_useMyClassificationCorrections', 'Use my classification corrections'), aiTagMode: t('shell_tagsFromAi', 'Tags from AI'), resumeClassificationWhenOnline: t('prefs_finishPendingClassificationWhen', 'Finish pending classification when back online') };
      for (const [key, value] of Object.entries(response.conflictValues?.local ?? {})) {
        const remote = response.conflictValues?.remote[key as keyof BookmarkPreferences];
        if (value === remote) continue;
        const term = document.createElement('dt'); term.textContent = labels[key] ?? key;
        const detail = document.createElement('dd'); detail.textContent = t('prefs_thisBrowserAccount', 'This browser: $1 / Account: $2', plain(key, value), plain(key, remote));
        const row = document.createElement('div'); row.append(term, detail); conflictValues.append(row);
      }
    }
    onChanged(response.preferences.foldersFirst);
    document.dispatchEvent(new Event('known:capture-preferences-changed'));
    currentConflict = response.conflict;
    accountDefaults = response.accountDefaults ?? response.conflictValues?.remote;
    useServer.textContent = response.conflict ? t('options_useServerValues', 'Use server values')
      : t('prefs_useAccountDefaults', 'Use account defaults on this browser');
    useServer.hidden = !response.conflict && !accountDefaults;
    useLocal.hidden = !response.conflict;
    useServer.disabled = !response.conflict && !accountDefaults;
    useLocal.disabled = !response.conflict;
    if (response.conflict) say(t('prefs_anotherDeviceChangedThese', 'Another device changed these preferences. Choose which values to keep before editing again.'), 'warning');
    else if (response.pending) say(t('prefs_savedBrowserWillSync', 'Saved on this browser. Account sync is pending.'));
    else if (accountDefaults) say(t('shell_accountDefaultsDiffer', 'Your account has different saving defaults from this browser.'));
    else say('');
  }

  function setBusy(value: boolean): void {
    for (const [key, control] of Object.entries(subscriptionFields)) if (control) control.disabled = value || currentConflict || !supportedSubscriptions.has(key);
    for (const control of [mode, duration, learning, resume, ...tagButtons]) if (control) control.disabled = value || currentConflict;
    syncModeChoices();
    top.disabled = value; bottom.disabled = value; folders.disabled = value;
    useServer.disabled = value || !currentConflict && !accountDefaults; useLocal.disabled = value || !currentConflict;
  }

  return Object.freeze({ refresh });
}

async function request(message: Partial<BookmarkPreferences> & { readonly kind: string; readonly userGesture?: true; readonly choice?: 'server' | 'local' }): Promise<BookmarkPreferencesResponse> {
  try { return await chrome.runtime.sendMessage(message) as BookmarkPreferencesResponse; }
  catch { return { ok: false, error: 'preferences_unavailable' }; }
}
