import { parseHubRoute } from './options-router.js';
import type { NativeNode } from './bookmark-manager-dom.js';
import { t } from './i18n.js';
export function createBookmarkManagerNavigation(host: HTMLElement) {
  let applied = '', pendingId: string | undefined;
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.className = 'meta';
  const back = document.createElement('a'); back.className = 'btn btn-secondary'; back.textContent = t('capture_returnCapture', 'Return to capture'); back.hidden = true;
  host.querySelector('.page-head')?.after(status, back);
  return {
    reset() { applied = ''; pendingId = undefined; },
    /** Picks out this row after the next render, the way a capture link does. */
    reveal(id: string) { pendingId = id; },
    async prepare(nodes: ReadonlyMap<string, NativeNode>, editing: boolean) {
      const route = parseHubRoute(location.hash), key = route.hash;
      if (route.pane !== 'bookmarks') return null;
      const returnTo = route.params.get('return'); back.hidden = !returnTo; back.href = returnTo ? `#${returnTo}` : '#history';
      if (applied === key || !route.params.has('native') && !route.params.has('node')) return null;
      if (editing) { status.textContent = t('manager_finishCurrentEditLocate', 'Finish the current edit to locate the requested bookmark. Your draft is preserved.'); return null; }
      let id = route.params.get('native');
      if (!id && route.params.get('node')) {
        const reply = await chrome.runtime.sendMessage({ kind: 'known.capture.navigation.resolve', nodeId: route.params.get('node'), collectionId: route.params.get('collection') }) as { ok: boolean; nativeId?: string };
        if (location.hash !== key) return null;
        if (!reply?.ok || !reply.nativeId) { status.textContent = t('manager_cloudBookmarkNotMapped', 'This bookmark from your library isn’t on this browser.'); applied = key; return null; }
        id = reply.nativeId;
      }
      applied = key;
      const node = id ? nodes.get(id) : undefined;
      if (!node) { status.textContent = t('manager_originalBookmarkUnavailableDeleted', 'The original bookmark is unavailable or was deleted. Its capture history is retained.'); return null; }
      const ancestors: string[] = []; let parent = node.parentId; const seen = new Set<string>();
      while (parent && !seen.has(parent)) { seen.add(parent); ancestors.push(parent); parent = nodes.get(parent)?.parentId; }
      pendingId = node.id; status.textContent = t('manager_locatedItsCurrentBrowser', 'Located at its current browser position. Ordinary edits here do not rate the original classification.');
      return { nativeId: node.id, folderId: node.parentId ?? node.id, ancestors };
    },
    highlight(list: HTMLElement) {
      if (!pendingId) return;
      const row = Array.from(list.querySelectorAll<HTMLElement>('[data-id]')).find(row => row.dataset.id === pendingId);
      if (!row) return;
      pendingId = undefined; row.dataset.captureLocated = 'true'; row.tabIndex = 0;
      row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' });
      setTimeout(() => { delete row.dataset.captureLocated; }, 4000);
    },
  };
}
