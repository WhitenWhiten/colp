import type { NativeNode } from './bookmark-manager-dom.js';
import { t } from './i18n.js';
/** Bound DOM work for large native folders; selection remains owned by the manager. */
export function createManagerPage() {
  let folder = '', offset = 0, focusId: string | undefined;
  return {
    locate(id: string) { focusId = id; },
    render(host: HTMLElement, folderId: string, children: readonly NativeNode[], row: (node: NativeNode) => HTMLElement, repaint: () => void) {
      if (folder !== folderId) { folder = folderId; offset = 0; }
      if (focusId) { const index = children.findIndex(node => node.id === focusId); if (index >= 0) offset = Math.floor(index / 200) * 200; focusId = undefined; }
      offset = Math.min(offset, Math.max(0, Math.floor((children.length - 1) / 200) * 200));
      for (const node of children.slice(offset, offset + 200)) host.append(row(node));
      if (children.length <= 200) return;
      const navigation = document.createElement('nav'); navigation.setAttribute('aria-label', t('common_bookmarkPages', 'Bookmark pages')); navigation.className = 'mgr-pages';
      const summary = document.createElement('span'); summary.textContent = t('manager_selectionAppliesVisibleRows', '$1–$2 of $3 · selection applies to visible rows', offset + 1, Math.min(children.length, offset + 200), children.length);
      const previous = document.createElement('button'), next = document.createElement('button');
      previous.textContent = t('common_previousBookmarks', 'Previous bookmarks'); next.textContent = t('common_nextBookmarks', 'Next bookmarks'); previous.disabled = offset === 0; next.disabled = offset + 200 >= children.length;
      for (const button of [previous, next]) { button.type = 'button'; button.className = 'btn btn-secondary'; }
      previous.addEventListener('click', () => { offset = Math.max(0, offset - 200); repaint(); host.querySelector<HTMLElement>('[data-id]')?.focus(); });
      next.addEventListener('click', () => { offset += 200; repaint(); host.querySelector<HTMLElement>('[data-id]')?.focus(); });
      navigation.append(previous, summary, next); host.append(navigation);
    },
  };
}
