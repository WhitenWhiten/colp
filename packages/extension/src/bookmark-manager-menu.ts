import { t } from './i18n.js';

export interface MenuItem { readonly label: string; readonly run: () => void; readonly tone?: 'danger' }

/**
 * The row's action menu: opened with the ⋯ button, a right-click or the
 * keyboard (Menu key, Shift+F10). It floats above the page, closes on any
 * outside press, Escape, Tab or scroll, and arrow keys roam its items.
 */
export function createManagerMenu() {
  let menu: HTMLDivElement | undefined, anchor: HTMLElement | undefined;
  function close(restoreFocus = false): void {
    menu?.remove(); menu = undefined;
    const target = anchor; anchor = undefined;
    if (restoreFocus) target?.focus();
  }
  document.addEventListener('pointerdown', (event) => {
    if (menu && event.target instanceof Node && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu) close(true); });
  window.addEventListener('scroll', () => { close(); }, true);

  function openAt(x: number, y: number, items: readonly MenuItem[], from: HTMLElement): void {
    close();
    anchor = from;
    const next = document.createElement('div');
    next.className = 'mgr-menu';
    next.setAttribute('role', 'menu');
    next.setAttribute('aria-label', t('common_itemActions', 'Item actions'));
    next.addEventListener('keydown', (event) => {
      const choices = Array.from(next.querySelectorAll<HTMLButtonElement>('.mgr-menu-item'));
      const at = choices.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const to = event.key === 'ArrowDown' ? (at + 1) % choices.length
          : event.key === 'ArrowUp' ? (at - 1 + choices.length) % choices.length
            : event.key === 'Home' ? 0 : choices.length - 1;
        choices[to]?.focus();
      } else if (event.key === 'Tab') close();
    });
    for (const item of items) {
      const choice = document.createElement('button');
      choice.type = 'button'; choice.className = 'mgr-menu-item';
      choice.setAttribute('role', 'menuitem');
      if (item.tone) choice.dataset.tone = item.tone;
      choice.textContent = item.label;
      choice.addEventListener('click', () => { close(); item.run(); });
      next.append(choice);
    }
    menu = next;
    document.body.append(next);
    const rect = next.getBoundingClientRect();
    next.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    next.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    next.querySelector<HTMLButtonElement>('.mgr-menu-item')?.focus();
  }
  return { openAt, close, isOpen: () => menu !== undefined };
}

let shared: ReturnType<typeof createManagerMenu> | undefined;
/** One menu for a page: it listens to the whole document, so rows that share a page share it. */
export function sharedManagerMenu(): ReturnType<typeof createManagerMenu> {
  return (shared ??= createManagerMenu());
}
