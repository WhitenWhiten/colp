import { initI18n, localizePage, onUiLanguageChanged } from './i18n.js';

/* The tip text lives in ::after (display:none until hover/focus), which screen
   readers never announce; each pill also points at a hidden copy of it. Re-run
   after a language change so the copies follow the new catalog. */
export function hydrateInfoTips(root: ParentNode = document): void {
  for (const [index, pill] of Array.from(root.querySelectorAll<HTMLElement>('.info-pill[data-tip]')).entries()) {
    let text = document.getElementById(`info-tip-${index}`);
    if (!text) {
      text = document.createElement('span');
      text.id = `info-tip-${index}`; text.className = 'visually-hidden';
      pill.after(text); pill.setAttribute('aria-describedby', text.id);
    }
    text.textContent = pill.dataset.tip ?? '';
  }
}

/**
 * Page bootstrap: localize now, apply the stored language once it resolves,
 * then re-localize on every later change. Resolves true when a manual
 * language is in force — callers can await it before first render.
 */
export function bindPageLanguage(afterLocalize: () => void = () => undefined): Promise<boolean> {
  const relocalize = () => { localizePage(); afterLocalize(); };
  relocalize();
  onUiLanguageChanged(() => { try { relocalize(); } catch { /* A paint failure must not mute later changes. */ } });
  return initI18n().then(applied => {
    if (applied) { try { relocalize(); } catch { /* A paint failure must not break the page's init. */ } }
    return applied;
  });
}
