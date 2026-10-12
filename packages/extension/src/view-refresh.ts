import { createScopedRefresh } from '../design/scopedRefresh.js';
/** UI reads only; native ingress persists each event before any view refresh. */
export function createViewRefresh(input: { active(): boolean; editing(): boolean; refresh(): Promise<void>; online?: boolean }) {
  const queue = createScopedRefresh({ canRun: () => input.active() && !input.editing() && document.visibilityState !== 'hidden'
    && (input.online !== true || navigator.onLine !== false), refresh: input.refresh });
  const invalidate = () => queue.invalidate('view');
  window.addEventListener('focus', invalidate); window.addEventListener('online', invalidate);
  document.addEventListener('visibilitychange', invalidate);
  document.addEventListener('focusout', () => { setTimeout(queue.wake, 0); });
  const observer = new MutationObserver(() => queue.wake());
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
  return { invalidate, wake: queue.wake, reset: queue.reset };
}
export function preserveViewPosition(host: HTMLElement) {
  const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
  const row = active?.closest<HTMLElement>('[data-id], [data-capture-id]');
  const id = active?.id, rowId = row?.dataset.id ?? row?.dataset.captureId;
  const label = active?.getAttribute('aria-label'), scroll = { x: window.scrollX, y: window.scrollY };
  const positions = [host, ...Array.from(host.querySelectorAll<HTMLElement>('.mgr-list, .mgr-tree'))].map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
  return () => {
    if (active && !active.isConnected && document.activeElement === document.body) {
      const candidates = Array.from(host.querySelectorAll<HTMLElement>('[data-id], [data-capture-id]'));
      const nextRow = candidates.find(node => (node.dataset.id ?? node.dataset.captureId) === rowId);
      const replacement = id ? document.getElementById(id) : label && nextRow
        ? Array.from(nextRow.querySelectorAll<HTMLElement>('[aria-label]')).find(node => node.getAttribute('aria-label') === label) : nextRow;
      (replacement ?? host).focus({ preventScroll: true });
    }
    for (const { node, top, left } of positions) { node.scrollTop = top; node.scrollLeft = left; }
    window.scrollTo(scroll.x, scroll.y);
  };
}
