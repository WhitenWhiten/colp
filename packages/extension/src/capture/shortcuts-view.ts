import { localized, t } from '../i18n.js';
import { createIcon } from '../icons.js';
/* Shortcuts live in the manifest and are rebound in the browser's own page,
   so this view only reads them and points there — people can't use a
   shortcut they were never told about. */
let labels: Record<string, string>;
localized(() => {
  labels = { _execute_action: t('shell_savePageShortcut', 'Save this page'), 'save-window-tabs': t('capture_saveAllTabsWindow', 'Save all tabs in this window') };
});

const part = (tag: 'div' | 'p' | 'span' | 'kbd', className: string, text?: string) => {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const row = (title: string, hint: string | undefined, ...controls: Node[]) => {
  const container = part('div', 'set-row'), copy = part('div', 'set-row-text'), side = part('div', 'set-row-control');
  copy.append(part('p', 'set-row-title', title)); if (hint) copy.append(part('p', 'set-row-hint', hint));
  side.append(...controls); container.append(copy, side); return container;
};

/** `host` is the Keyboard shortcuts group; its card is filled with one row per command plus the way to change them. */
export function createShortcutsView(host: HTMLElement) {
  const card = host.querySelector<HTMLElement>('[data-capture-shortcut-rows]') ?? host;
  const change = document.createElement('button'); change.type = 'button'; change.className = 'btn btn-ghost btn-sm';
  change.append(t('shell_openBrowserShortcuts', 'Open browser shortcuts'), createIcon('arrow-up-right', 13));
  change.addEventListener('click', () => { void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined); });
  return {
    async activate() {
      const commands = await chrome.commands.getAll().catch(() => []);
      card.replaceChildren();
      for (const command of commands) {
        if (!command.name || !(command.name in labels)) continue;
        const keys: Node[] = [];
        if (command.shortcut) for (const key of command.shortcut.split('+')) keys.push(part('kbd', 'kbd-key', key));
        else keys.push(part('span', 'set-row-value', t('common_notSet', 'Not set')));
        card.append(row(labels[command.name]!, undefined, ...keys));
      }
      host.hidden = !card.children.length;
      if (!host.hidden) card.append(row(t('common_changeShortcuts', 'Change shortcuts'), t('shell_shortcutsManaged', 'Shortcuts are managed by your browser.'), change));
    },
  };
}
