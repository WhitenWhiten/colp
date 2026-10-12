import { t } from '../i18n.js';
import type { Send } from './client.js';
import { button, el, errorCopy, modal, pill, status } from './dom.js';
import { createNativePicker, type FolderSelection } from './native-picker.js';
export interface DirectoryDefaults { mountParentNativeId?: string | null; preservationParentNativeId?: string | null }
export function createDirectoryPreferences(host: HTMLElement, send: Send) {
  let generation = 0, picker: ReturnType<typeof createNativePicker> | undefined, open: ReturnType<typeof modal> | undefined;
  const feedback = status(), content = el('div'); host.replaceChildren(feedback, content);
  async function load() {
    const version = ++generation;
    try {
      const defaults = await send<DirectoryDefaults>({ kind: 'directoryDefaults' }); if (version !== generation) return;
      content.replaceChildren();
      for (const [key, label] of [['mountParentNativeId', t('subscription_defaultMount', 'Where new subscription folders go')], ['preservationParentNativeId', t('subscription_defaultPreservation', 'Backup folder for your changes')]] as const) {
        // A settings row: label and what it holds on the left, the status and the picker on the right.
        const row = el('div', undefined, 'set-row'), copy = el('div', undefined, 'set-row-text'), side = el('div', undefined, 'set-row-control');
        const pick = button(t('subscription_chooseLocation', 'Choose location'), () => choose(key, label)); pick.classList.add('btn-sm');
        copy.append(el('p', label, 'set-row-title'), el('p', defaults[key] ? t('subscription_directoryConfigured', 'Set for this browser. Checked again before each use.') : t('subscription_directoryUnconfigured', 'Not set. Pick a folder you own, for example Bookmarks bar › Know-N Subscriptions.'), 'set-row-hint'));
        side.append(pill(defaults[key] ? t('subscription_directorySet', 'Set') : t('subscription_directoryNotSet', 'Not set'), defaults[key] ? 'success' : 'muted'), pick); row.append(copy, side); content.append(row);
      }
    } catch (error) { if (version === generation) feedback.textContent = errorCopy(error); }
  }
  function choose(key: keyof DirectoryDefaults, label: string) {
    open?.dialog.close(); picker?.dispose(); const version = generation; let selection: FolderSelection | undefined, token: string | undefined, expiresAt = 0, busy = false;
    open = modal(label); const dialog = open, localFeedback = status(), pickerHost = el('div');
    const confirm = button(t('subscription_reviewLocation', 'Review location'), () => { void save(); }, true);
    dialog.body.append(el('p', t('subscription_directoryScope', 'This choice applies to this browser only. Existing folders are not moved.'), 'field-hint'), pickerHost, localFeedback); dialog.actions.append(confirm);
    picker = createNativePicker(pickerHost, send, value => { selection = value; token = undefined; confirm.textContent = t('subscription_reviewLocation', 'Review location'); confirm.disabled = !value || busy; });
    confirm.disabled = true;
    async function save() {
      if (!selection || busy) return; busy = true; confirm.disabled = true;
      try {
        if (!token || expiresAt <= Date.now()) {
          const result = await send<{ token: string; expiresAt: number }>({ kind: 'directoryPreview', [key]: selection.id });
          if (version !== generation) return; token = result.token; expiresAt = result.expiresAt;
          localFeedback.textContent = selection.path + ' · ' + t('subscription_confirmDirectoryHint', 'Confirm to use this folder from now on. Nothing is moved now.'); confirm.textContent = t('subscription_confirmLocation', 'Confirm location');
        } else {
          await send<DirectoryDefaults>({ kind: 'directoryConfirm', token }); if (version !== generation) return;
          picker?.dispose(); dialog.dialog.close(); open = undefined; await load(); feedback.textContent = t('subscription_directorySaved', 'Saved.');
        }
      } catch (error) { if (version === generation) { token = undefined; confirm.textContent = t('subscription_reviewLocation', 'Review location'); localFeedback.textContent = errorCopy(error); } }
      finally { busy = false; if (version === generation) confirm.disabled = !selection; }
    }
  }
  void load(); return { dispose() { generation++; picker?.dispose(); open?.dialog.close(); host.replaceChildren(); } };
}
