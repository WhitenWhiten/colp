import { parseHubRoute } from '../options-router.js';
import { t } from '../i18n.js';
export function bindCaptureSyncNavigation(host: HTMLElement) {
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.className = 'meta';
  const back = document.createElement('a'); back.className = 'btn btn-secondary'; back.textContent = t('capture_returnCapture', 'Return to capture');
  host.querySelector('.page-head')?.after(status, back);
  let focused = '';
  const refresh = () => {
    const route = parseHubRoute(location.hash), returnTo = route.params.get('return');
    back.hidden = !returnTo; back.href = returnTo ? `#${returnTo}` : '#history';
    const id = route.params.get('item'), node = route.params.get('node');
    if (route.pane !== 'sync' || !id && !node) { status.textContent = ''; focused = ''; return; }
    const target = Array.from(host.querySelectorAll<HTMLElement>('[data-sync-item], [data-sync-node]')).find(row => id ? row.dataset.syncItem === id : row.dataset.syncNode === node);
    const text = target ? t('capture_confirmationItemBelongsCapture', 'This confirmation item belongs to the capture you opened.') : t('capture_noMatchingConfirmationCurrently', 'No matching confirmation is currently listed. It may already be resolved or unavailable in this collection.');
    if (status.textContent !== text) status.textContent = text;
    if (target && focused !== route.hash) { focused = route.hash; target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); target.dataset.captureLocated = 'true'; }
  };
  const observer = new MutationObserver(refresh); observer.observe(host, { childList: true, subtree: true });
  window.addEventListener('hashchange', refresh); window.addEventListener('popstate', refresh); refresh();
}
