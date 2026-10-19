import { createDialog, dialogButton } from '../dialog.js';
import { relativeText, t, tn } from '../i18n.js';
import { el, selectOf } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { BrowserListEntryView, BrowserRulesetView } from './messages.js';
import { dialogSummary, optionGroup } from './dialog-parts.js';
import { sendRuleCommand as send } from './rule-command.js';
import { rolePickers, showProblems } from './ruleset-pane.js';
import { confirmRollback } from './subscription-review-pane.js';
import { subscriptionAddress, subscriptionOriginPattern } from './subscription-fetch.js';
import type { BrowserSubscriptionEntryView, BrowserSubscriptionView, RefreshInterval } from './subscription-messages.js';
import type { FailureCode } from './subscription-store.js';

/**
 * Subscribe to a rule set, and a subscription's settings (doc 17 §8 Subscribe, RS-04, RS-12, R14): the
 * address is `https` (or `http` on this machine); reading its site is asked for in the click, before
 * anything else, and the worker then fetches and checks the file and says what it holds. Its roles get
 * folders here, updates wait for review unless the Owner chooses otherwise, and a subscription whose
 * first fetch fails is still added, not ready, with the failure and Refresh now.
 */
type Entry = Extract<BrowserListEntryView, { kind: 'subscription' }>;
const close = (dialog: HTMLDialogElement, trigger?: HTMLElement | null) =>
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
const errorLine = () => { const node = el('p', undefined, 'form-error'); node.setAttribute('role', 'alert'); node.hidden = true; return node; };
export const siteOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** A fetch's failure in words, with when (RS-04.2). */
export function failureWords(code: FailureCode, origin: string, at: number, status?: number): string {
  const site = siteOf(origin), ago = relativeText(at);
  switch (code) {
    case 'network': return t('automation_subFailNetwork', 'Couldn’t reach $1, $2.', site, ago);
    case 'http': return t('automation_subFailHttp', 'Couldn’t fetch it from $1 (HTTP $2), $3.', site, String(status ?? ''), ago);
    case 'tooLarge': return t('automation_subFailTooLarge', 'The file at $1 is larger than 2 MB, $2.', site, ago);
    case 'invalid': return t('automation_subFailInvalid', 'The file at $1 isn’t a rule set this browser can use, $2.', site, ago);
    case 'unsupported': return t('automation_subFailUnsupported', 'The file at $1 moved to another site or is in a newer format, $2.', site, ago);
    case 'permission': return t('automation_subFailPermission', 'This browser isn’t allowed to read $1 yet.', site);
  }
}
/** The last failure in words; null when there is none. */
export const failureText = (view: Pick<BrowserSubscriptionView, 'origin' | 'lastFailure'>): string | null =>
  view.lastFailure ? failureWords(view.lastFailure.code, view.origin, view.lastFailure.at, view.lastFailure.status) : null;

function policyField(current: BrowserSubscriptionView['updatePolicy']): { readonly element: HTMLElement; value(): BrowserSubscriptionView['updatePolicy'] } {
  const field = el('div', undefined, 'form-field');
  const label = el('p', t('automation_subPolicy', 'New versions'), 'form-label');
  const choices = optionGroup('radio', [
    { value: 'review', title: t('automation_subPolicyReview', 'Wait for my review'), hint: t('automation_subPolicyReviewHint', 'You see what changes before it files anything.'), checked: current === 'review' },
    { value: 'auto', title: t('automation_subPolicyAuto', 'Apply small updates by themselves'),
      hint: t('automation_subPolicyAutoHint', 'Applies updates that change conditions and sites but add no new folder roles; anything else waits for your review.'), checked: current === 'auto' }],
  t('automation_subPolicy', 'New versions'));
  field.append(label, choices.element);
  return { element: field, value: () => (choices.inputs.find((input) => input.checked)?.value ?? 'review') as 'review' | 'auto' };
}
function intervalField(current: RefreshInterval): { readonly element: HTMLElement; readonly select: HTMLSelectElement } {
  const select = selectOf([['6', t('automation_subEvery6', 'Every 6 hours')], ['24', t('automation_subEveryDay', 'Once a day')],
    ['168', t('automation_subEveryWeek', 'Once a week')]], String(current));
  select.className = 'field-select'; select.id = `automation-sub-interval-${crypto.randomUUID()}`;
  const field = el('div', undefined, 'form-field');
  const label = el('label', t('automation_subInterval', 'Check for updates'), 'form-label'); label.htmlFor = select.id;
  field.append(label, select, el('p', t('automation_subIntervalHint', 'Only while this browser is open.'), 'mgr-hint'));
  return { element: field, select };
}

/** What the checked file holds, its folders and its settings; Subscribe adds it. `view` is null when it couldn't be fetched now. */
function subscribeStep(dialog: HTMLDialogElement, body: HTMLElement, actions: HTMLElement, url: string, view: BrowserRulesetView | null, problem: string | null): void {
  body.replaceChildren();
  if (view) {
    // What the address holds and where it came from, then what it would do here, in one box.
    body.append(dialogSummary([view.name, t('automation_rulesetVersion', 'version $1', view.version), view.publisher ?? '', view.license ?? ''].filter(Boolean).join(' · '),
      el('p', [t('automation_subFetchedFrom', 'Fetched from $1 over $2', siteOf(url), url.startsWith('https:') ? 'HTTPS' : 'HTTP'),
        tn('automation_rulesetRules', view.rules, '$1 rule', '$1 rules'), view.matchingOnly ? tn('automation_subNamingCount', view.matchingOnly,
          '$1 entry names a site only', '$1 entries name a site only') : ''].filter(Boolean).join(' · '), 'mgr-hint'),
      view.sample ? el('p', view.sample.matched ? tn('automation_rulesetSample', view.sample.matched, 'Its rules would file $1 of your last $2 bookmarks.',
        'Its rules would file $1 of your last $2 bookmarks.', view.sample.size) : t('automation_rulesetSampleNone', 'None of your last $1 bookmarks match its rules.', view.sample.size), 'detail') : null));
    if (view.roles.length) body.append(el('p', t('automation_rulesetRolesHint', 'Choose a folder here for each kind of page it files. A role you leave without a folder waits: its rules don’t file anything until you choose one.'), 'mgr-hint'));
  } else {
    body.append(el('p', t('automation_subCheckFailed', 'Couldn’t check it now: $1 You can still subscribe; it files nothing until a version arrives.', problem ?? ''), 'detail'));
  }
  const pickers = rolePickers(view?.roles ?? [], {}, body, dialog);
  const policy = policyField('review'), interval = intervalField(24);
  const error = errorLine();
  body.append(policy.element, interval.element, error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const add = dialogButton(t('automation_subSubscribe', 'Subscribe'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  add.addEventListener('click', () => {
    add.disabled = true; error.hidden = true;
    const bindings = Object.fromEntries([...pickers].map(([key, picker]) => [key, picker.value() || null]));
    void send({ kind: 'known.automation.browser.subscribe', url, bindings, updatePolicy: policy.value(),
      refreshIntervalHours: Number(interval.select.value) as RefreshInterval }).then((reply) => {
      add.disabled = false;
      if (reply.ok && 'subscription' in reply) {
        dialog.close();
        const made = reply.subscription;
        showToast(made.state === 'ready' ? t('automation_subAdded', 'Subscribed to “$1”. It is tried after the rest of your list.', made.name)
          : t('automation_subAddedNotReady', 'Subscribed, but not ready yet: $1', failureText(made) ?? ''), made.state === 'ready' ? 'ok' : 'error', { announce: true });
        return;
      }
      const code = reply.ok ? '' : reply.error;
      error.textContent = code === 'duplicate' ? t('automation_subDuplicate', 'You already subscribe to this address.')
        : code === 'limit' ? t('automation_subLimit', 'This browser keeps up to 20 subscriptions. Remove one to add another.')
          : code === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
            : t('automation_subAddFailed', 'Couldn’t subscribe. Try again.');
      error.hidden = false;
    });
  });
  actions.replaceChildren(cancel, add);
  add.focus();
}

export function openSubscribe(trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_subTitle', 'Subscribe to a rule set'), 'automation-config-dialog automation-subscribe');
  const form = el('form'); form.noValidate = true;
  const input = el('input', undefined, 'field-quiet'); input.type = 'url'; input.id = `automation-sub-url-${crypto.randomUUID()}`;
  input.placeholder = 'https://example.org/rules.json'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 2_048;
  const label = el('label', t('automation_subUrl', 'Address of the rule set'), 'form-label'); label.htmlFor = input.id;
  const error = errorLine();
  const field = el('div', undefined, 'form-field');
  field.append(label, input, el('p', t('automation_subUrlHint', 'A colp.ruleset/v1 file on an https address. Know-N asks to read that site, and fetches nothing else from it.'), 'mgr-hint'), error);
  body.append(field);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const check = dialogButton(t('automation_subCheck', 'Check'), 'primary'); check.type = 'submit';
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, check);
  dialog.replaceChildren(dialog.querySelector('h3')!, form);
  form.append(body, actions);
  input.addEventListener('input', () => { error.hidden = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Past the check, the form holds the summary; Enter does not check again.
    if (!body.contains(input)) return;
    const address = subscriptionAddress(input.value);
    if (!address.ok) { error.textContent = t('automation_subBadUrl', 'Use an https address, such as https://example.org/rules.json.'); error.hidden = false; input.focus(); return; }
    check.disabled = true;
    // Asked in the click, before anything is awaited, so the browser shows its prompt (R14).
    void chrome.permissions.request({ origins: [subscriptionOriginPattern(address.origin)] }).catch(() => false).then(async (granted) => {
      // Not allowed: nothing is fetched; Check asks again.
      if (!granted) {
        check.disabled = false;
        error.textContent = t('automation_subNeedsAccessCheck', 'Allow reading $1 to check this rule set. Know-N reads nothing else from that site.', siteOf(address.url));
        error.hidden = false;
        return;
      }
      const reply = await send({ kind: 'known.automation.browser.subscription.check', url: address.url });
      check.disabled = false;
      if (reply.ok && 'ruleset' in reply) { subscribeStep(dialog, body, actions, address.url, reply.ruleset, null); return; }
      if (!reply.ok && reply.rulesetProblems?.length) { dialog.close(); showProblems(siteOf(address.url), reply.rulesetProblems, trigger ?? document.body); return; }
      const code = reply.ok ? 'network' : reply.error;
      const known = ['network', 'http', 'tooLarge', 'invalid', 'unsupported', 'permission'].includes(code) ? code as FailureCode : 'network';
      subscribeStep(dialog, body, actions, address.url, null, failureWords(known, address.origin, Date.now(), reply.ok ? undefined : reply.status));
    });
  });
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); input.focus();
}

export function openSubscriptionSettings(entry: Entry, trigger?: HTMLElement | null): void {
  const view = entry.subscription!;
  const { dialog, body, actions } = createDialog(t('automation_subSettingsTitle', 'Updates for “$1”', view.name), 'automation-config-dialog');
  const policy = policyField(view.updatePolicy), interval = intervalField(view.refreshIntervalHours);
  // Pinned: whatever the policy, no version applies by itself; new ones wait for review (RS-13.3).
  const holds = optionGroup('checkbox', [
    { value: 'pause', title: t('automation_subPause', 'Pause updates'), hint: t('automation_subPauseHint', 'Keeps version $1 and stops checking for new ones.', view.currentVersion ?? '—'), checked: view.paused },
    { value: 'pin', title: t('automation_subPin', 'Pin version $1', view.currentVersion ?? '—'),
      hint: t('automation_subPinHint', 'Keeps checking, but no new version applies by itself. Unpinning goes back to the choice above.'), checked: view.pinned }]);
  const [box, pinBox] = holds.inputs as [HTMLInputElement, HTMLInputElement];
  const error = errorLine();
  body.append(policy.element, interval.element, holds.element);
  if (view.previousVersion) {
    const back = el('div', undefined, 'automation-sub-section-inline');
    const use = dialogButton(t('automation_rollback', 'Use previous version'), 'secondary');
    use.addEventListener('click', () => { dialog.close(); confirmRollback(entry, trigger); });
    back.append(el('p', t('automation_subPreviousHint', 'Version $1 is kept, so you can go back to it.', view.previousVersion), 'mgr-hint'), use);
    body.append(back);
  }
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(t('common_save', 'Save'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => {
    save.disabled = true;
    void send({ kind: 'known.automation.browser.subscription.update', id: view.id, updatePolicy: policy.value(),
      refreshIntervalHours: Number(interval.select.value) as RefreshInterval, paused: box.checked, pinned: pinBox.checked }).then((reply) => {
      save.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_subSettingsSaved', 'Saved the update settings for “$1”.', view.name), 'ok', { announce: true }); return; }
      error.textContent = t('automation_subSettingsFailed', 'Couldn’t save these settings. Try again.'); error.hidden = false;
    });
  });
  actions.append(cancel, save);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); save.focus();
}

export function openSubscriptionFolders(entry: Entry, trigger?: HTMLElement | null): void {
  const view = entry.subscription!, roles = entry.detail?.roles ?? [];
  const { dialog, body, actions } = createDialog(t('automation_rulesetBindTitle', 'Folders for “$1”', view.name), 'automation-config-dialog');
  body.append(el('p', t('automation_subBindHint', 'Each kind of page this subscription files goes to the folder you choose here. Updates keep your choices.'), 'mgr-hint'));
  const pickers = rolePickers(roles, Object.fromEntries(roles.flatMap((role) => role.folder ? [[role.key, role.folder.nativeId]] : [])), body, dialog);
  const error = errorLine();
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const save = dialogButton(t('common_save', 'Save'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => {
    save.disabled = true;
    const bindings = Object.fromEntries([...pickers].map(([key, picker]) => [key, picker.value() || null]));
    void send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'bindings', bindings } }).then((reply) => {
      save.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_rulesetBound', 'Saved the folders for “$1”.', view.name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
        : t('automation_rulesetBindFailed', 'Couldn’t save these folders. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, save);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); save.focus();
}

export function confirmRemoveSubscription(entry: Entry, trigger?: HTMLElement | null): void {
  const name = entry.subscription?.name ?? t('automation_subscription', 'Subscribed rule set');
  const { dialog, body, actions } = createDialog(t('automation_subRemoveTitle', 'Remove “$1”?', name));
  body.append(el('p', t('automation_subRemoveBody', 'Its entries stop filing pages, and your settings for it go too. Rules you copied from it stay. Pages it already filed stay where they are.'), 'mgr-hint'));
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const remove = dialogButton(t('automation_subRemove', 'Remove subscription'), 'danger');
  cancel.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', () => {
    remove.disabled = true;
    void send({ kind: 'known.automation.browser.subscription.remove', id: entry.id }).then((reply) => {
      dialog.close();
      showToast(reply.ok ? t('automation_subRemoved', 'Removed “$1”.', name) : t('automation_subRemoveFailed', 'Couldn’t remove this subscription. Try again.'),
        reply.ok ? 'ok' : 'error', { announce: true });
    });
  });
  actions.append(cancel, remove);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}

/** Copy to my rules from a subscription (RS-05.4): above it, so it is tried first and can be changed; the entry here switched off when asked. */
export function confirmCopyEntry(subscriptionId: string, sourceName: string, item: BrowserSubscriptionEntryView, trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_copyTitle', 'Copy “$1” to your rules?', item.name));
  body.append(el('p', item.folder ? t('automation_subCopyHint', 'The copy goes above “$1” as a rule of your own, filing into $2. It is tried before the subscription, and you can change it.', sourceName, item.folder.title)
    : t('automation_subCopyHintKeep', 'The copy goes above “$1” as a rule of your own. It is tried before the subscription, and you can change it.', sourceName), 'mgr-hint'));
  const turnOff = optionGroup('checkbox', [{ value: 'off', title: t('automation_copyTurnOff', 'Also turn off the original in “$1”', sourceName), checked: true }]);
  const box = turnOff.inputs[0]!;
  const error = errorLine();
  body.append(turnOff.element, error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const copy = dialogButton(t('automation_copy', 'Copy to my rules'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  copy.addEventListener('click', () => {
    copy.disabled = true;
    void send({ kind: 'known.automation.browser.subscription.copy', id: subscriptionId, entryId: item.id, disableOriginal: box.checked }).then((reply) => {
      copy.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_copied', 'Copied “$1” above “$2”.', item.name, sourceName), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'unbound' ? t('automation_copyUnbound', 'Its kind of page has no folder here yet. Choose the subscription’s folders first.')
        : reply.error === 'limit' ? t('automation_listLimit', 'This browser keeps up to 200 rules on their own and 1,000 in all. Delete one to add another.')
          : t('automation_copyFailed', 'Couldn’t copy this rule. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, copy);
  close(dialog, trigger);
  document.body.append(dialog); dialog.showModal(); copy.focus();
}
