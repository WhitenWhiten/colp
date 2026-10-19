import { createDialog, dialogButton } from '../dialog.js';
import { t, tn } from '../i18n.js';
import { el } from '../library-dom.js';
import { showToast } from '../toast.js';
import type { BrowserListEntryView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';
import { rolePickers } from './ruleset-pane.js';
import type { ScopeReason } from './ruleset-format.js';
import type { BrowserSubscriptionReviewView } from './subscription-messages.js';

/**
 * Review a subscription's waiting version (doc 17 RS-12.1, R10): its entries by id — added, removed,
 * changed —, the kinds of page it adds or drops (a new one gets its folder here), whether *Automatic*
 * would have applied it, and how many recent bookmarks another entry or folder would take. *Apply* makes
 * it current; nothing already saved moves, and there is nothing to undo here (RS-14.1, RS-14.4).
 */
type Entry = Extract<BrowserListEntryView, { kind: 'subscription' }>;
const SHOWN = 20;

export function scopeCopy(reason: ScopeReason): string {
  return reason === 'roles' ? t('automation_reviewScopeRoles', 'It changes the kinds of page it files, so it always waits for your review.')
    : t('automation_reviewScopeDocument', 'It is a different rule set at this address, so it always waits for your review.');
}

function names(title: string, items: readonly { readonly name: string }[]): HTMLElement | null {
  if (!items.length) return null;
  const box = el('div', undefined, 'automation-review-group');
  const list = el('ul', undefined, 'automation-run-folders');
  for (const item of items.slice(0, SHOWN)) list.append(el('li', item.name));
  if (items.length > SHOWN) list.append(el('li', tn('automation_reviewMore', items.length - SHOWN, 'and $1 more', 'and $1 more')));
  box.append(el('p', `${title} (${items.length})`, 'form-label'), list);
  return box;
}

function show(entry: Entry, review: BrowserSubscriptionReviewView, trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_reviewTitle', 'Version $1 of “$2”', review.candidateVersion, review.name), 'automation-config-dialog automation-review');
  const { diff, scope, sample } = review;
  body.append(el('p', t('automation_reviewNow', 'Version $1 files pages now. Applying this one moves no bookmark you already have.', review.currentVersion), 'detail'),
    el('p', scope.ok ? t('automation_reviewScopeOk', 'It keeps the same kinds of page, so Automatic would have applied it.') : scopeCopy(scope.reasons[0]!), 'mgr-hint'));
  const groups = [names(t('automation_reviewAdded', 'Added'), diff.added), names(t('automation_reviewChanged', 'Changed'), diff.changed),
    names(t('automation_reviewRemoved', 'Removed'), diff.removed), names(t('automation_reviewRolesRemoved', 'Kinds of page it no longer files'),
      diff.roles.removed.map((role) => ({ name: role.description || role.key })))].filter((node): node is HTMLElement => node !== null);
  body.append(...groups.length ? groups : [el('p', t('automation_reviewNoEntries', 'No entry changes; only its details do.'), 'detail')]);
  if (sample) {
    body.append(el('p', sample.changed ? tn('automation_reviewSample', sample.changed, 'Of your last $2 bookmarks, $1 would be filed differently:',
      'Of your last $2 bookmarks, $1 would be filed differently:', sample.size) : tn('automation_reviewSampleNone', sample.size, 'Your last bookmark would be filed the same way.',
      'None of your last $1 bookmarks would be filed differently.'), 'detail'));
    if (sample.byFolder.length) {
      const list = el('ul', undefined, 'automation-run-folders');
      for (const row of sample.byFolder.slice(0, 5)) {
        list.append(el('li', row.title ? tn('automation_reviewSampleFolder', row.count, '$2: $1 bookmark', '$2: $1 bookmarks', row.title)
          : tn('automation_reviewSampleStay', row.count, 'Stay where saved: $1 bookmark', 'Stay where saved: $1 bookmarks')));
      }
      body.append(list);
    }
  }
  // A kind of page it adds files nowhere until it has a folder here; choose it now, or later.
  if (diff.roles.added.length) body.append(el('p', t('automation_reviewRolesAdded', 'New kinds of page it files. Choose a folder for each, or leave it to wait:'), 'form-label'));
  const pickers = rolePickers(diff.roles.added, {}, body, dialog);
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  body.append(error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const apply = dialogButton(t('automation_reviewApply', 'Apply version $1', review.candidateVersion), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  apply.addEventListener('click', () => {
    apply.disabled = true; error.hidden = true;
    const bindings = Object.fromEntries([...pickers].flatMap(([key, picker]) => picker.value() ? [[key, picker.value()]] : []));
    void (async () => {
      if (Object.keys(bindings).length) {
        const bound = await send({ kind: 'known.automation.browser.subscription.adjust', id: entry.id, change: { kind: 'bindings', bindings } });
        if (!bound.ok) return bound;
      }
      return send({ kind: 'known.automation.browser.subscription.apply', id: entry.id });
    })().then((reply) => {
      apply.disabled = false;
      if (reply.ok) { dialog.close(); showToast(t('automation_reviewApplied', 'Now using version $1 of “$2”.', review.candidateVersion, review.name), 'ok', { announce: true }); return; }
      error.textContent = reply.error === 'folderGone' ? t('automation_configFolderGone', 'One of the folders you chose is gone, or a bookmark subscription keeps it. Choose another one.')
        : reply.error === 'notFound' ? t('automation_reviewGone', 'This version isn’t waiting any more. Close and look again.')
          : t('automation_reviewApplyFailed', 'Couldn’t apply this version. Try again.');
      error.hidden = false;
    });
  });
  actions.append(cancel, apply);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); apply.focus();
}

export function openReview(entry: Entry, trigger?: HTMLElement | null): void {
  void send({ kind: 'known.automation.browser.subscription.review', id: entry.id }).then((reply) => {
    if (reply.ok && 'review' in reply) { show(entry, reply.review, trigger); return; }
    showToast(t('automation_reviewFailed', 'Couldn’t compare this version. Try again.'), 'error', { announce: true });
  });
}

/** Use previous version (RS-13.3): the version before goes back in force and is pinned there; adjustments stay. */
export function confirmRollback(entry: Entry, trigger?: HTMLElement | null): void {
  const view = entry.subscription!;
  const { dialog, body, actions } = createDialog(t('automation_rollbackTitle', 'Use version $1 of “$2” again?', view.previousVersion ?? '', view.name));
  body.append(el('p', t('automation_rollbackBody', 'Version $1 files pages again, and it stays pinned until you unpin it. Your settings for this subscription stay. Bookmarks already saved don’t move.', view.previousVersion ?? ''), 'mgr-hint'));
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const back = dialogButton(t('automation_rollback', 'Use previous version'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  back.addEventListener('click', () => {
    back.disabled = true;
    void send({ kind: 'known.automation.browser.subscription.rollback', id: entry.id }).then((reply) => {
      dialog.close();
      showToast(reply.ok ? t('automation_rolledBack', 'Using version $1 of “$2” again, pinned.', view.previousVersion ?? '', view.name)
        : t('automation_rollbackFailed', 'Couldn’t go back to the previous version. Try again.'), reply.ok ? 'ok' : 'error', { announce: true });
    });
  });
  actions.append(cancel, back);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); cancel.focus();
}
