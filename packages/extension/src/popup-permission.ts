import { element, paintPermissionGate } from './popup-dom.js';
import { clearSaveFeedback } from './save-feedback.js';

/**
 * The permission dialog steals focus and Chrome closes the popup with it, so
 * asking mid-save aborted the save. The missing permission is a deliberate
 * step instead: an inline alert at the top of the body with its Allow button.
 * The draft cache covers the popup closing anyway.
 */
export function bindBookmarkPermission(onGranted: () => void) {
  const note = element('permission-note');
  const grant = element('permission-grant');
  grant.addEventListener('click', () => { void request(); });

  async function reflect(): Promise<void> {
    try { note.hidden = await chrome.permissions.contains({ permissions: ['bookmarks'] }); }
    catch { note.hidden = true; }
    paintPermissionGate();
  }

  async function request(): Promise<void> {
    let granted = false;
    try { granted = await chrome.permissions.request({ permissions: ['bookmarks'] }); }
    catch {
      try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch { granted = false; }
    }
    note.hidden = granted;
    paintPermissionGate();
    if (!granted) return;
    void clearSaveFeedback();
    try { void chrome.action.setBadgeText({ text: '' }); } catch { /* no action context */ }
    void chrome.runtime.sendMessage({ kind: 'known.roots.permissionChanged', userGesture: true, granted: true })
      .catch(() => undefined);
    onGranted();
  }

  return {
    reflect,
    /** A save found the permission missing: surface the alert and gate Save. */
    show(): void { note.hidden = false; paintPermissionGate(); },
  };
}
