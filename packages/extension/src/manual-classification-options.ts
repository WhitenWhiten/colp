import { t } from './i18n.js';
import { showToast } from './toast.js';
import { MANUAL_CLASSIFICATION_AUTO, manualClassificationRequested } from './manual-classification.js';
import { onSwitch, setSwitch } from './toggle-switch.js';

/** "Suggest when the Manual form opens": a Saving switch, saved on this browser. */
export function bindManualClassificationOptions() {
  const control = document.getElementById('capture-manual-suggestions') as HTMLButtonElement | null;
  if (!control) return;
  control.disabled = true;
  const ready = manualClassificationRequested().then(enabled => { setSwitch(control, enabled); })
    .finally(() => { control.disabled = false; });
  onSwitch(control, enabled => {
    control.disabled = true;
    void chrome.storage.local.set({ [MANUAL_CLASSIFICATION_AUTO]: enabled })
      .then(() => { showToast(t('capture_savedBrowser', 'Saved for this browser.'), 'ok'); })
      .catch(() => {
        setSwitch(control, !enabled);
        showToast(t('prefs_manualSuggestionsNotSaved', 'Could not save automatic suggestions. Try again.'), 'error');
      }).finally(() => { control.disabled = false; });
  });
  return ready;
}
