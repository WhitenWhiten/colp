import { RUNTIME_ORIGIN_KEY } from './config.js';
import { httpOriginConfirmation } from './http-origin.js';
import { managedServerOrigin } from './managed-policy.js';
import { requestServerOriginPermission } from './server-origin-permission.js';
import { showToast } from './toast.js';
import { t } from './i18n.js';

export interface ServerOriginFieldPorts {
  validate(origin: string): Promise<void>;
  disconnect(nextOrigin: string): Promise<void>;
  refresh(): Promise<void>;
}

/** Authorize and verify a new server before retiring the old connection. */
export async function bindServerOriginField(ports: ServerOriginFieldPorts): Promise<{ ready(): Promise<void> }> {
  const input = document.getElementById('server-origin') as HTMLInputElement | null;
  let pending = Promise.resolve();
  const ready = () => pending;
  if (!input) return { ready };
  try {
    const origin = managedServerOrigin(await chrome.storage.managed.get(['serverOrigin']));
    if (origin) { input.value = origin; input.disabled = true; return { ready }; }
  } catch { /* managed storage is absent */ }
  const stored = (await chrome.storage.local.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY];
  let saved = typeof stored === 'string' ? stored : '';
  input.value = saved;
  input.addEventListener('change', event => {
    if (!event.isTrusted || input.disabled) return;
    const raw = input.value.trim();
    let origin = '';
    try {
      if (raw) {
        const url = new URL(raw);
        if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search
            || url.hash || url.username || url.password) throw new Error('invalid_origin');
        origin = url.origin;
      }
    } catch {
      input.setAttribute('aria-invalid', 'true');
      showToast(t('options_serverOriginInvalid', 'Enter a server origin, such as https://colp.example.net.'), 'error', { announce: true });
      pending = Promise.reject(new Error('server_configuration_failed')); void pending.catch(() => undefined);
      return;
    }
    if (!origin && !saved) { input.removeAttribute('aria-invalid'); pending = Promise.resolve(); return; }
    const kind = origin ? httpOriginConfirmation(origin) : 'none';
    if (kind === 'refused') {
      input.setAttribute('aria-invalid', 'true');
      showToast(t('options_httpOriginRefused', "Plain HTTP works only for a server on this computer (localhost, 127.0.0.1, [::1]). On a home network, use https:// with the server's tls-internal profile."), 'error', { announce: true });
      pending = Promise.reject(new Error('server_configuration_failed')); void pending.catch(() => undefined);
      return;
    }
    if (kind === 'loopback' && origin !== saved && !window.confirm(t('options_httpOriginUnencrypted', 'This server uses plain HTTP. Credentials and bookmarks travel unencrypted.'))) {
      input.value = saved; pending = Promise.resolve(); input.removeAttribute('aria-invalid'); return;
    }
    // Chromium requires the permission request to start synchronously in the gesture.
    const grant = origin ? requestServerOriginPermission(origin) : Promise.resolve(true);
    input.disabled = true;
    pending = (async () => {
      if (!await grant) throw new Error('permission_required');
      if (origin) await ports.validate(origin);
      if (origin !== saved) await ports.disconnect(origin);
      if (origin) await chrome.storage.local.set({ [RUNTIME_ORIGIN_KEY]: origin });
      else await chrome.storage.local.remove(RUNTIME_ORIGIN_KEY);
      saved = origin; input.value = origin; input.removeAttribute('aria-invalid');
      await ports.refresh();
    })().catch(error => {
      input.setAttribute('aria-invalid', 'true');
      const denied = error instanceof Error && error.message === 'permission_required';
      showToast(denied
        ? t('options_serverPermissionDenied', 'Allow access to this server before connecting.')
        : t('options_serverSaveFailed', 'Could not connect to this COLP server. Check its address and availability, then try again.'), 'error', { announce: true });
      throw new Error('server_configuration_failed');
    }).finally(() => { input.disabled = false; });
    void pending.catch(() => undefined);
  });
  return { ready };
}
