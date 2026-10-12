import { createDialog, dialogButton } from './dialog.js';
import { t } from './i18n.js';
import { preferenceHash } from './preferences-navigation.js';
import type { RootRequest } from './types.js';

type OptionalPermission = 'bookmarks' | 'tabs';
export function bindPermissionSettings(): void {
  const panel = document.getElementById('pref-permissions');
  if (!panel) return;
  const feedback = document.getElementById('permissions-feedback')!;
  const controls = (permission: OptionalPermission) => ({
    grant: document.getElementById(`permissions-grant-${permission}`) as HTMLButtonElement,
    revoke: document.getElementById(`permissions-revoke-${permission}`) as HTMLButtonElement,
    status: document.getElementById(`permissions-status-${permission}`)!,
    dot: document.getElementById(`permissions-dot-${permission}`),
  });
  async function refresh() {
    try {
      for (const permission of ['bookmarks', 'tabs'] as const) {
        const granted = await chrome.permissions.contains({ permissions: [permission] });
        const row = controls(permission); row.grant.hidden = granted; row.revoke.hidden = !granted;
        row.status.textContent = granted ? t('common_allowed', 'Allowed') : t('shell_off', 'Off');
        if (row.dot) { if (granted) delete row.dot.dataset.tone; else row.dot.dataset.tone = 'off'; }
      }
    } catch { feedback.textContent = t('permissions_readFailed', 'Permission status could not be read. Reload this page to try again.'); }
  }
  async function change(permission: OptionalPermission, operation: 'request' | 'remove', output: HTMLElement = feedback, stay = false) {
    try {
      const changed = await chrome.permissions[operation]({ permissions: [permission] });
      if (!changed) { output.textContent = t('permissions_unchanged', 'Permission was not changed.'); return; }
      if (permission === 'bookmarks') void chrome.runtime.sendMessage({ kind: 'known.roots.permissionChanged',
        userGesture: true, granted: operation === 'request' } satisfies RootRequest).catch(() => undefined);
      // From Sync › Folders the page reloads where it is; from General it lands on the Permissions rows.
      if (!stay) location.hash = preferenceHash('permissions');
      location.reload();
    } catch { output.textContent = t('permissions_changeFailed', 'Permission could not be changed. Try again.'); }
  }
  function openRevoke(permission: OptionalPermission, stay = false) {
    const title = permission === 'bookmarks' ? t('options_removeBookmarkAccess', 'Remove bookmark access') : t('permissions_removeTabAccess', 'Remove tab access');
    const { dialog, body, actions } = createDialog(title);
    dialog.id = 'remove-permission-dialog';
    const explanation = document.createElement('p'); explanation.id = 'permission-revoke-copy';
    explanation.textContent = permission === 'bookmarks'
      ? t('permissions_removeBookmarksCopy', 'Saving and bookmark management stop until you allow access again. Existing bookmarks and Know-N copies are kept.')
      : t('permissions_removeTabsCopy', 'Saving all tabs will ask for tab access again. Saving the current page and existing bookmarks are unchanged.');
    const keep = dialogButton(t('common_keepAccess', 'Keep access')), remove = dialogButton(t('common_removeAccess', 'Remove access'), 'danger');
    keep.id = 'remove-permission-cancel'; remove.id = 'remove-permission-confirm';
    body.append(explanation); actions.append(keep, remove);
    keep.addEventListener('click', () => dialog.close());
    remove.addEventListener('click', event => {
      if (event.isTrusted && navigator.userActivation.isActive) { dialog.close(); void change(permission, 'remove', feedback, stay); }
    });
    dialog.addEventListener('close', () => { dialog.remove(); });
    document.body.append(dialog); dialog.showModal(); keep.focus();
  }
  for (const permission of ['bookmarks', 'tabs'] as const) {
    const row = controls(permission);
    row.grant.addEventListener('click', event => { if (event.isTrusted && navigator.userActivation.isActive) void change(permission, 'request'); });
    row.revoke.addEventListener('click', () => openRevoke(permission));
  }
  document.getElementById('request-bookmark-permission')?.addEventListener('click', event => {
    if (event.isTrusted && navigator.userActivation.isActive) void change('bookmarks', 'request', document.getElementById('root-feedback')!, true);
  });
  document.getElementById('remove-bookmark-permission')?.addEventListener('click', () => openRevoke('bookmarks', true));
  window.addEventListener('focus', () => { void refresh(); });
  chrome.permissions.onAdded.addListener(() => { void refresh(); });
  chrome.permissions.onRemoved?.addListener(() => { void refresh(); });
  void refresh();
}
