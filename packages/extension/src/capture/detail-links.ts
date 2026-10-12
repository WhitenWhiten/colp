import type { CaptureTask } from './contracts.js';
import { t } from '../i18n.js';
export function appendCaptureDetailLinks(actions: HTMLElement, task: CaptureTask) {
  const originRoute = location.hash.startsWith('#history') ? location.hash.slice(1) : `history?task=${task.captureId}`;
  const link = (label: string, path: string, values: Record<string, string>) => {
    const node = document.createElement('a'); node.textContent = label; node.className = 'btn btn-ghost btn-sm';
    node.href = `#${path}?${new URLSearchParams({ ...values, return: originRoute })}`; actions.append(node);
  };
  void chrome.runtime.sendMessage({ kind: 'known.capture.links', captureId: task.captureId }).then(raw => {
    const result = raw as { ok: boolean; item: string | null; nodeId: string | null; chargeId: string | null; bound: boolean };
    if (!result?.ok) return;
    if (task.sync !== 'local-only' && result.bound) link(result.item ? t('capture_reviewSyncConfirmation', 'Review this sync confirmation') : t('capture_checkBookmarksSync', 'Check this bookmark’s sync'), 'sync',
      { task: task.captureId, ...(result.item ? { item: result.item } : {}), ...(result.nodeId ? { node: result.nodeId } : {}) });
    if (result.chargeId) link(t('capture_viewClassificationsCredits', 'View this classification’s credits'), 'credits', { chargeId: result.chargeId });
    else if (['insufficient_credits', 'period_credit_limit'].includes(task.reason ?? '')) link(t('common_reviewCredits', 'Review credits'), 'credits', {});
  }).catch(() => { /* Existing detail operations remain usable without this optional navigation lookup. */ });
}
