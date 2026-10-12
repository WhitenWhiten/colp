import { readUiLanguage, setUiLanguage } from './i18n.js';

/** General › Language: the device-local override of the extension's UI
 *  copy. Saving reloads the page so every surface re-renders in the chosen
 *  language; the router restores this section from the hash. */
export function bindUiLanguageSettings(): void {
  const select = document.getElementById('ui-language') as HTMLSelectElement | null;
  if (!select) return;
  void readUiLanguage().then(value => { select.value = value; });
  select.addEventListener('change', () => {
    select.disabled = true;
    void setUiLanguage(select.value).then(() => location.reload(), () => { select.disabled = false; });
  });
}
