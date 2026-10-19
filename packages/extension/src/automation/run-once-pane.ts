import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { createDialog, dialogButton } from '../dialog.js';
import { createIcon } from '../icons.js';
import { t, tn } from '../i18n.js';
import { button, el } from '../library-dom.js';
import { createFolderPicker, folderChoices, type FolderSourceNode } from '../library-folder-picker.js';
import { when } from '../subscriptions-ui/dom.js';
import { showToast } from '../toast.js';
import type { AutomationStateView, BrowserRunPreviewView, BrowserRunView } from './messages.js';
import { sendRuleCommand as send } from './rule-command.js';

/**
 * Options › Rules in this browser › Run once (doc 17 §6.4, RS-14): the list over the bookmarks already
 * in one folder. The dialog asks for the folder, shows what would move and where most of it goes, and
 * moves only on a second click; the runs card below the list keeps each run's Undo. The worker plans,
 * moves and undoes (sw/automation-run.ts); this page only asks.
 */
function previewBlock(run: BrowserRunPreviewView): HTMLElement {
  const block = el('div', undefined, 'automation-run-result');
  const scope = run.scope.title || t('common_untitledFolder', 'Untitled folder');
  if (run.tooMany) {
    block.append(el('p', t('automation_runOnceTooMany', '“$1” holds more than 20,000 bookmarks. Choose a smaller folder.', scope), 'automation-preview-verdict'));
    return block;
  }
  if (!run.counted) { block.append(el('p', t('automation_runOnceEmpty', '“$1” has no bookmarks to sort.', scope), 'automation-preview-verdict')); return block; }
  block.append(el('p', run.moves ? tn('automation_runOnceWouldMove', run.moves, '$1 of $2 bookmarks in “$3” would move.', '$1 of $2 bookmarks in “$3” would move.', run.counted, scope)
    : t('automation_runOnceNothing', 'Nothing in “$1” would move.', scope), 'automation-preview-verdict'));
  const rest = [
    run.unchanged ? tn('automation_runOnceUnchanged', run.unchanged, '$1 already in place', '$1 already in place') : '',
    run.kept ? tn('automation_runOnceKept', run.kept, '$1 kept where it is by a rule', '$1 kept where they are by a rule') : '',
    run.unmatched ? tn('automation_runOnceUnmatched', run.unmatched, '$1 matches no rule', '$1 match no rule') : '',
    run.blocked ? tn('automation_runOnceBlocked', run.blocked, '$1 can’t be filed here: its folder isn’t available', '$1 can’t be filed here: their folders aren’t available') : '',
    run.excludedFolders ? tn('automation_runOnceExcluded', run.excludedFolders, '$1 subscription folder left out', '$1 subscription folders left out') : '',
  ].filter(Boolean);
  if (rest.length) block.append(el('p', rest.join(' · '), 'detail'));
  if (run.topFolders.length) {
    const folders = el('ul', undefined, 'automation-run-folders');
    for (const folder of run.topFolders) folders.append(el('li', tn('automation_runOnceToFolder', folder.count, '$2: $1 bookmark', '$2: $1 bookmarks', folder.title)));
    block.append(el('p', t('automation_runOnceWhere', 'Where they would go'), 'form-label'), folders);
  }
  if (run.examples.length) {
    const examples = el('ul');
    for (const example of run.examples) examples.append(el('li', t('automation_runOnceExample', '$1 → $2', example.title || example.url, example.to)));
    block.append(el('p', t('automation_runOnceExamples', 'For example'), 'form-label'), examples);
  }
  return block;
}

export function openRunOnce(trigger?: HTMLElement | null): void {
  const { dialog, body, actions } = createDialog(t('automation_runOnceTitle', 'Run your rules once'), 'automation-run-dialog');
  let preview: BrowserRunPreviewView | null = null;
  const result = el('div', undefined, 'automation-preview-output'); result.setAttribute('aria-live', 'polite');
  const error = el('p', undefined, 'form-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const picker = createFolderPicker({ choices: [], startEmpty: true, label: t('automation_runOnceFolder', 'Folder'),
    onChange: () => { preview = null; result.replaceChildren(); error.hidden = true; paint(); } });
  const field = el('div', undefined, 'form-field');
  field.append(el('p', t('automation_runOnceFolder', 'Folder'), 'form-label'), picker.element);
  body.append(el('p', t('automation_runOnceHint', 'Your rules sort the bookmarks already in a folder, its subfolders too, as if you had just saved them. Nothing moves until you confirm, and you can undo the run.'), 'mgr-hint'),
    field, result, error);
  const cancel = dialogButton(t('common_cancel', 'Cancel'));
  const go = dialogButton(t('automation_runOncePreview', 'Preview'), 'primary');
  cancel.addEventListener('click', () => dialog.close());
  actions.append(cancel, go);
  function paint(): void {
    go.textContent = preview?.moves && !preview.tooMany ? tn('automation_runOnceApply', preview.moves, 'Move $1 bookmark', 'Move $1 bookmarks') : t('automation_runOncePreview', 'Preview');
  }
  function fail(copy: string): void { error.textContent = copy; error.hidden = false; }
  const problem = (code: string) => code === 'changed' ? t('automation_runOnceChanged', 'Your rules changed since this preview. Preview again.')
    : code === 'expired' ? t('automation_runOnceExpired', 'This preview expired. Preview again.')
      : code === 'listOff' ? t('automation_runOnceListOff', 'Rules in this browser are switched off. Turn them on to run them.')
        : code === 'excluded' ? t('automation_runOnceExcludedScope', 'A bookmark subscription keeps this folder. Choose one of your own.')
          : code === 'notFound' ? t('automation_runOnceGone', 'This folder is gone. Choose another one.')
            : code === 'noAccess' ? t('automation_runOnceNoAccess', 'Know-N needs access to your bookmarks to sort them.') : t('automation_runOnceFailed', 'Couldn’t run your rules. Try again.');
  go.addEventListener('click', () => {
    error.hidden = true;
    if (!preview || !preview.moves || preview.tooMany) {
      const scopeNativeId = picker.value();
      if (!scopeNativeId) { fail(t('automation_runOnceNeedFolder', 'Choose the folder to sort.')); picker.pill.focus(); return; }
      go.disabled = true;
      void send({ kind: 'known.automation.browser.runPreview', scopeNativeId }).then((reply) => {
        go.disabled = false;
        if (!reply.ok || !('run' in reply)) { preview = null; result.replaceChildren(); paint(); fail(problem(reply.ok ? '' : reply.error)); return; }
        preview = reply.run; result.replaceChildren(previewBlock(reply.run)); paint();
      });
      return;
    }
    const { previewId } = preview;
    go.disabled = true; cancel.disabled = true;
    void send({ kind: 'known.automation.browser.runApply', previewId }).then((reply) => {
      go.disabled = false; cancel.disabled = false;
      if (!reply.ok || !('result' in reply)) {
        preview = null; result.replaceChildren(); paint(); fail(problem(reply.ok ? '' : reply.error)); return;
      }
      dialog.close();
      const left = reply.result.skipped + reply.result.missing;
      showToast(`${tn('automation_runOnceMoved', reply.result.moved, 'Moved $1 bookmark.', 'Moved $1 bookmarks.')}${left
        ? ` ${tn('automation_runOnceLeft', left, '$1 had changed meanwhile and was left alone.', '$1 had changed meanwhile and were left alone.')}` : ''} ${t('automation_runOnceUndoWhere', 'You can undo this run under Runs.')}`,
      'ok', { announce: true });
    });
  });
  void (async () => {
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch { granted = false; }
    if (!granted || typeof chrome.bookmarks?.getTree !== 'function') { fail(problem('noAccess')); go.disabled = true; picker.pill.disabled = true; return; }
    const [roots, hidden] = await Promise.all([chrome.bookmarks.getTree() as Promise<FolderSourceNode[]>, exclusionIds().catch(() => new Set<string>())]);
    if (dialog.isConnected) picker.setChoices(folderChoices(roots, { exclude: hidden }));
  })().catch(() => undefined);
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
  document.body.append(dialog); dialog.showModal(); picker.pill.focus();
}

function runRow(run: BrowserRunView): HTMLLIElement {
  const item = el('li', undefined, 'list-row automation-run-row'); item.dataset.runId = run.runId;
  const main = el('div', undefined, 'list-row-main');
  const meta = el('p', undefined, 'list-row-meta');
  meta.append(el('span', tn('automation_runOnceRowMoved', run.moved, '$1 moved', '$1 moved')),
    ...(run.skipped ? [el('span', undefined, 'sep'), el('span', tn('automation_runOnceRowSkipped', run.skipped, '$1 left alone', '$1 left alone'))] : []),
    ...(run.undone ? [el('span', undefined, 'sep'), el('span', tn('automation_runOnceRowUndone', run.undone, '$1 moved back', '$1 moved back'))] : []),
    el('span', undefined, 'sep'), when(run.startedAt));
  main.append(el('p', t('automation_runOnceRowTitle', 'Ran on “$1”', run.scopeTitle || t('common_untitledFolder', 'Untitled folder')), 'list-row-title'), meta);
  const tail = el('div', undefined, 'list-row-tail');
  const state = run.state === 'undone' ? t('automation_runOnceStateUndone', 'Undone') : run.state === 'running' ? t('automation_runOnceStateRunning', 'Running')
    : run.state === 'interrupted' ? t('automation_runOnceStateInterrupted', 'Stopped early') : null;
  if (state) tail.append(el('span', state, 'badge'));
  if (run.canUndo) {
    const undo = button(t('automation_runOnceUndo', 'Undo'), 'btn btn-secondary btn-sm', () => {
      undo.disabled = true;
      void send({ kind: 'known.automation.browser.runUndo', runId: run.runId }).then((reply) => {
        undo.disabled = false;
        if (!reply.ok || !('result' in reply)) { showToast(t('automation_runOnceUndoFailed', 'Couldn’t undo this run. Try again.'), 'error', { announce: true }); return; }
        const left = reply.result.skipped + reply.result.missing;
        showToast(`${tn('automation_runOnceMovedBack', reply.result.moved, 'Moved $1 bookmark back.', 'Moved $1 bookmarks back.')}${left
          ? ` ${tn('automation_runOnceChangedSince', left, '$1 had changed since and stayed where it is.', '$1 had changed since and stayed where they are.')}` : ''}`, 'ok', { announce: true });
      });
    });
    undo.setAttribute('aria-label', t('automation_runOnceUndoLabel', 'Undo the run on “$1”', run.scopeTitle));
    tail.append(undo);
  }
  const tile = el('span', undefined, 'favicon-tile'); tile.append(createIcon('move', 16));
  item.append(tile, main, tail);
  return item;
}

/** The last runs with their Undo, under the list; nothing until there has been a run. */
export function runList(view: AutomationStateView): HTMLElement | null {
  if (!view.browserRuns?.length) return null;
  const card = el('section', undefined, 'list-card automation-runs-card');
  card.setAttribute('aria-labelledby', 'automation-runs-heading');
  const head = el('div', undefined, 'automation-runs-head');
  const heading = el('h3', t('automation_runOnceListTitle', 'Runs')); heading.id = 'automation-runs-heading';
  head.append(heading, el('p', t('automation_runOnceListHint', 'Undo moves back only what is still where the run left it.'), 'detail'));
  const list = el('ul', undefined, 'automation-rules automation-runs-list');
  for (const run of view.browserRuns) list.append(runRow(run));
  card.append(head, list);
  return card;
}
