import { t } from '../i18n.js';
import type { Send } from './client.js';
import { button, el, errorCopy, field, select, status } from './dom.js';
import { createIcon } from '../icons.js';
export type Folder = { id: string; title: string; parentId?: string; index?: number; disabled: boolean; reason?: string };
export interface FolderSelection { id: string; path: string; index?: number }
export function createNativePicker(host: HTMLElement, send: Send, changed: (value: FolderSelection | undefined) => void, initial?: FolderSelection, initialIndex?: number) {
  const feedback = status(), tree = el('div', undefined, 'subscription-folder-tree'), path = el('p', undefined, 'subscription-selected-path'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', t('subscription_folderTree', 'Browser bookmark folders'));
  const position = select([['bottom', t('subscription_bottom', 'At the bottom')], ['top', t('subscription_top', 'At the top')], ['index', t('subscription_position', 'Specific position')]], (initial?.index ?? initialIndex) === 0 ? 'top' : (initial?.index ?? initialIndex) === undefined ? 'bottom' : 'index');
  const index = el('input'); index.type = 'number'; index.min = '0'; index.step = '1'; index.value = String(initial?.index ?? initialIndex ?? 0);
  const indexField = field(t('subscription_index', 'Position (0 = first)'), index); indexField.hidden = position.value !== 'index';
  let selected: FolderSelection | undefined = initial, generation = 0, disposed = false;
  const announce = () => { if (!selected) return; const value = position.value === 'bottom' ? undefined : position.value === 'top' ? 0 : Number(index.value); const valid = value === undefined || Number.isSafeInteger(value) && value >= 0; index.setAttribute('aria-invalid', String(!valid)); changed(valid ? { id: selected.id, path: selected.path, ...(value === undefined ? {} : { index: value }) } : undefined); };
  position.addEventListener('change', () => { indexField.hidden = position.value !== 'index'; announce(); }); index.addEventListener('input', announce);
  const grant = button(t('common_allowBookmarkAccess', 'Allow bookmark access'), () => {
    // Direct click preserves user activation; the worker rechecks before operating.
    if (disposed) return; const pending = chrome.permissions.request({ permissions: ['bookmarks'] });
    void pending.then(allowed => { if (disposed) return; if (allowed) return load(); feedback.textContent = t('subscription_permissionDenied', 'Bookmark access is still off. No folder was created.'); }).catch(error => { feedback.textContent = errorCopy(error); });
  });
  const showPath = (value: string) => { path.replaceChildren(); path.hidden = !value; if (value) path.append(createIcon('folder', 14), el('span', value)); };
  showPath(initial?.path ?? ''); const placement = el('div', undefined, 'subscription-fields'); placement.append(field(t('subscription_insertPosition', 'Position in folder'), position), indexField);
  host.classList.add('subscription-picker'); host.replaceChildren(grant, feedback, path, tree, placement);
  async function branches(parent: HTMLElement, parentId: string | undefined, ancestry: string[], version: number) {
    const result = await send<{ nodes: Folder[] }>({ kind: 'folders', ...(parentId ? { parentId } : {}) });
    if (disposed || version !== generation) return;
    parent.replaceChildren();
    for (const folder of result.nodes) {
      const row = el('div'); row.setAttribute('role', 'treeitem'); row.tabIndex = tree.querySelector('[role=treeitem]') ? -1 : 0; row.addEventListener('focus', () => { for (const item of Array.from(tree.querySelectorAll<HTMLElement>('[role=treeitem]'))) item.tabIndex = item === row ? 0 : -1; }); row.setAttribute('aria-expanded', 'false'); row.setAttribute('aria-selected', String(selected?.id === folder.id));
      row.setAttribute('aria-label', folder.title);
      const children = el('div'); children.setAttribute('role', 'group'); children.hidden = true;
      const expand = button('', () => { void toggle(); }); expand.className = 'subscription-tree-toggle'; expand.append(createIcon('chevron-right', 14)); expand.setAttribute('aria-label', t('subscription_expand', 'Expand folder') + ': ' + folder.title);
      const choose = button(folder.title, () => { if (folder.disabled) return; for (const item of Array.from(tree.querySelectorAll('[aria-selected]'))) item.setAttribute('aria-selected', 'false'); row.setAttribute('aria-selected', 'true'); selected = { id: folder.id, path: [...ancestry, folder.title].join(' › ') }; showPath(selected.path); announce(); }); choose.className = 'subscription-tree-name';
      expand.tabIndex = -1; choose.tabIndex = -1; choose.disabled = folder.disabled; row.setAttribute('aria-disabled', String(folder.disabled));
      const reason = el('span', folder.reason === 'managed' ? t('subscription_managedFolder', 'Managed by your organization') : folder.reason === 'readonly_subscription' ? t('subscription_readonlyFolder', 'Subscription folder (read-only)') : folder.reason ?? '', 'detail'); if (folder.disabled) { reason.id = 'folder-reason-' + crypto.randomUUID(); choose.setAttribute('aria-describedby', reason.id); row.setAttribute('aria-describedby', reason.id); }
      async function toggle() { if (!children.hidden) { children.hidden = true; row.setAttribute('aria-expanded', 'false'); return; } children.hidden = false; row.setAttribute('aria-expanded', 'true'); try { await branches(children, folder.id, [...ancestry, folder.title], version); } catch (error) { feedback.textContent = errorCopy(error); } }
      row.addEventListener('keydown', event => {
        if (event.target !== row) return;
        if (event.key === 'ArrowRight') { event.preventDefault(); if (children.hidden) void toggle(); else children.querySelector<HTMLElement>('[role=treeitem]')?.focus(); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); if (!children.hidden) void toggle(); else row.parentElement?.closest<HTMLElement>('[role=treeitem]')?.focus(); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose.click(); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role=treeitem]')).filter(item => !item.closest('[hidden]')); const i = rows.indexOf(row); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, i + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
      });
      const line = el('div', undefined, 'subscription-tree-row'); line.append(expand, choose, reason); row.append(line, children); parent.append(row);
    }
  }
  async function load() { const version = ++generation; feedback.textContent = t('common_loading', 'Loading…'); try { await branches(tree, undefined, [], version); if (version === generation) { feedback.textContent = t('subscription_selectLocation', "Pick a folder to put it in. Read-only and managed folders can't be picked."); grant.hidden = true; } } catch (error) { if (version === generation) feedback.textContent = errorCopy(error); } }
  void chrome.permissions.contains({ permissions: ['bookmarks'] }).then(allowed => { if (allowed && !disposed) void load(); }).catch(() => undefined);
  return { dispose() { disposed = true; generation++; }, reload: load };
}
