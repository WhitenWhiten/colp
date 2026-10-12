import type { operations } from '../../../server/generated/openapi/product-v1.js';
import { createDialog, dialogButton } from '../dialog.js';
import { formatMoment, t, tn } from '../i18n.js';
type View = operations['getCaptureLearning']['responses'][200]['content']['application/json'];
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
};
/**
 * "Correction memory": a row under "Learn from my corrections" that says what Know-N remembers, with Clear.
 * The remembered folder choices sit behind a disclosure; the worker owns what is stored.
 */
export function createCaptureLearningView(host: HTMLElement) {
  let generation = 0;
  async function activate(focusClear = false) {
    const version = ++generation;
    const row = element('div', undefined, 'set-row'), text = element('div', undefined, 'set-row-text'), control = element('div', undefined, 'set-row-control');
    const status = element('p', t('capture_loadingPersonalMemory', 'Loading personal memory…'), 'set-row-hint'); status.setAttribute('role', 'status');
    text.append(element('p', t('shell_correctionMemory', 'Correction memory'), 'set-row-title'), status); row.append(text, control);
    host.replaceChildren(row);
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.capture.learning' }) as { ok: boolean; view?: View; pendingClear?: boolean };
      if (generation !== version) return;
      if (!response?.ok || !response.view) throw new Error();
      const view = response.view;
      status.textContent = !view.enabled ? t('capture_learningOffNoPersonal', 'Learning is off. No personal evidence is read or collected.')
        : view.records.length ? tn('shell_correctionsRemembered', view.records.length, '$1 correction remembered.', '$1 corrections remembered.')
          : t('capture_noCurrentExplicitChoices', 'No current explicit choices to show.');
      if (response.pendingClear) text.append(element('p', t('capture_previousClearRequestHas', 'The previous clear request has no confirmed result. Retry to check the same request.'), 'set-row-hint'));
      if (view.clearedAt) text.append(element('p', t('capture_memoryLastCleared', 'Memory last cleared: $1', formatMoment(view.clearedAt)), 'set-row-hint'));
      if (view.records.length) {
        const details = element('details', undefined, 'disclosure'), list = element('ul', undefined, 'set-row-hint');
        details.append(element('summary', t('shell_showCorrections', 'Show corrections')));
        for (const record of view.records) list.append(element('li', `${record.hostname}: ${record.beforePath.join(' › ')} → ${record.afterPath.join(' › ')} · ${formatMoment(record.receivedAt)}${record.available ? '' : ` · ${t('capture_folderUnavailable', 'folder unavailable')}`}`));
        details.append(list); text.append(details);
      }
      const clear = element('button', response.pendingClear ? t('capture_retryClearingMemory', 'Retry clearing memory') : t('shell_clear', 'Clear'), 'btn btn-ghost btn-sm'); clear.type = 'button';
      clear.addEventListener('click', () => {
        const { dialog, body, actions } = createDialog(t('capture_clearPersonalClassificationMemory', 'Clear personal classification memory'));
        const description = element('p', t('capture_bookmarksCaptureHistoryRetained', 'Bookmarks and capture history are retained. Previous evidence will no longer affect future choices.'));
        const cancel = dialogButton(t('common_cancel', 'Cancel')), confirm = dialogButton(t('common_clearMemory', 'Clear memory'), 'danger');
        body.append(description); actions.append(cancel, confirm); host.append(dialog);
        dialog.addEventListener('close', () => { dialog.remove(); clear.focus(); });
        cancel.addEventListener('click', () => dialog.close());
        confirm.addEventListener('click', () => {
          confirm.disabled = true;
          void chrome.runtime.sendMessage({ kind: 'known.capture.learning.clear', generation: view.generation }).then((result: unknown) => {
            if (generation !== version) return;
            if (!(result as { ok?: boolean } | null)?.ok) throw new Error();
            dialog.close(); return activate(true);
          }).catch(() => { if (generation === version) { description.textContent = t('capture_clearingNotConfirmedRetry', 'Clearing is not confirmed. Retry this request; your bookmarks are preserved.'); confirm.disabled = false; } });
        });
        dialog.showModal(); cancel.focus();
      });
      control.append(clear); if (focusClear) clear.focus();
    } catch { if (generation === version) status.textContent = t('capture_personalMemoryCouldNot', 'Personal memory could not be loaded. Sign in and reopen settings to retry.'); }
  }
  return { activate, deactivate() { generation++; for (const dialog of Array.from(host.querySelectorAll('dialog'))) dialog.remove(); } };
}
