import { createDialog, dialogButton } from './dialog.js';
import { button, el } from './library-dom.js';
import { t } from './i18n.js';

export function validDeviceHistoryClear(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
    && (value as { kind?: unknown }).kind === 'known.deviceHistory.clear'
    && (value as { userGesture?: unknown }).userGesture === true);
}
export function deviceHistoryClearButton(refresh: () => void): HTMLButtonElement {
  const control = button(t('history_clearDeviceDiary', 'Clear device save history'), 'btn btn-secondary btn-sm');
  control.id = 'device-history-clear';
  control.onclick = () => {
    const { dialog, body, actions } = createDialog(t('history_clearDeviceDiary', 'Clear device save history'));
    body.append(el('p', t('history_clearDeviceDiaryHint', 'Remove the device diary shared across sign-ins. Bookmarks, backups and other history records are kept. Previously cleared saves will not be migrated back into the device diary.')));
    const cancel = dialogButton(t('common_cancel', 'Cancel')), confirm = dialogButton(t('common_clear', 'Clear'), 'danger');
    actions.append(cancel, confirm); document.body.append(dialog); dialog.showModal();
    cancel.onclick = () => dialog.close();
    confirm.onclick = () => {
      confirm.disabled = true;
      void chrome.runtime.sendMessage({ kind: 'known.deviceHistory.clear', userGesture: true }).then(result => {
        if (!(result as { ok?: boolean })?.ok) throw new Error('clear_failed');
        dialog.close(); refresh();
      }).catch(() => { confirm.disabled = false; body.append(el('p', t('history_clearDeviceFailed', 'Device history could not be cleared. Try again.'))); });
    };
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
  };
  return control;
}
