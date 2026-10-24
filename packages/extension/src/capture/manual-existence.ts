import { createIcon } from '../icons.js';
import type { CaptureExistence, CaptureLocation } from './contracts.js';
import { t } from '../i18n.js';
let generation = 0;

/** Where each saved copy lives, as quiet links; the chosen folder pill already names a single editable one. */
function locationLinks(exact: readonly CaptureLocation[]): HTMLElement[] {
  if (exact.length === 1 && exact[0]!.nativeId) return [];
  return exact.map((location) => {
    const link = document.createElement('a');
    link.className = 'existence-path';
    link.append(createIcon('folder', 12), document.createTextNode(location.path.join(' › ') || location.collectionTitle || t('common_savedLocation', 'Saved location')));
    link.href = location.nativeId ? `options.html#bookmarks?native=${encodeURIComponent(location.nativeId)}`
      : `options.html#saving/history?node=${encodeURIComponent(location.nodeId ?? '')}`;
    link.target = '_blank';
    return link;
  });
}

/**
 * Asks the worker whether this page is already bookmarked and, when it is,
 * fills `#capture-existing-locations` (other locations and the "Save another
 * copy" choice) and announces it. The status line, footer and in-place editing
 * belong to popup-edit-existing.ts, which listens for `known:existence-shown`.
 */
export async function showManualCaptureExistence(url: string): Promise<void> {
  const own = ++generation;
  const reply = await chrome.runtime.sendMessage({ kind: 'known.capture.existence', url }).catch(() => null) as { ok?: boolean; existence?: CaptureExistence } | null;
  if (own !== generation || !reply?.ok || !reply.existence) return;
  const exact = reply.existence.exact;
  let host = document.getElementById('capture-existing-locations');
  if (!exact.length) { if (host) { host.remove(); document.dispatchEvent(new Event('known:existence-cleared')); } return; }
  if (!host) {
    host = document.createElement('section');
    host.id = 'capture-existing-locations';
    const fields = document.getElementById('pp-fields');
    if (fields) fields.after(host);
    else document.getElementById('capture')?.append(host);
  }
  const label = document.createElement('label'), checkbox = document.createElement('input');
  checkbox.type = 'checkbox'; checkbox.id = 'capture-save-another'; checkbox.dataset.url = url;
  label.className = 'check-line'; label.append(checkbox, document.createTextNode(t('capture_saveAnotherCopy', 'Save another copy')));
  const semantic = document.createElement('button'); semantic.type = 'button'; semantic.id = 'capture-semantic-save';
  semantic.textContent = 'Save as semantic / classify this copy';
  semantic.hidden = !/^https:\/\/www\.bilibili\.com\/video\/(?:av[1-9]\d*|BV[0-9A-Za-z]{10})(?:[/?#]|$)/u.test(url);
  semantic.onclick = () => { document.dispatchEvent(new CustomEvent('known:semantic-save', { detail: { url } })); };
  host.replaceChildren(...locationLinks(exact), label, semantic);
  // One writable native match: the popup can edit it in place (popup-edit-existing.ts).
  document.dispatchEvent(new CustomEvent('known:existence-shown', { detail: { url, exact } }));
}
/** Controls enable after the card may have mounted: ask the listeners to repaint once more. */
export function repaintExistenceSaveControl(): void {
  document.getElementById('capture-save-another')?.dispatchEvent(new Event('change', { bubbles: true }));
}
export async function allowManualCapture(url: string): Promise<boolean> {
  const checkbox = document.getElementById('capture-save-another') as HTMLInputElement | null;
  if (checkbox?.checked && checkbox.dataset.url === url) return true;
  const reply = await chrome.runtime.sendMessage({ kind: 'known.capture.existence', url }).catch(() => null) as { ok?: boolean; existence?: CaptureExistence } | null;
  if (reply?.existence?.exact.length) { await showManualCaptureExistence(url); return false; }
  return true;
}
