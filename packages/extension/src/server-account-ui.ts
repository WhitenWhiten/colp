import { isOlderThanSupportedServerMinor, RUNTIME_ORIGIN_KEY } from './config.js';
import { t } from './i18n.js';
import { fetchEditionVersion } from './server-edition.js';
import type { ExtensionResponse } from './types.js';

const editionRenders = new WeakMap<HTMLElement, symbol>();

export interface ServerAccountPorts {
  readonly busy: (text: string) => void;
  readonly render: (response: ExtensionResponse) => void;
  readonly requestDisconnect: () => Promise<ExtensionResponse>;
}

/** Account tab: edition version, older-server notice, and Disconnect server. */
export function bindServerAccount(ports: ServerAccountPorts): { refresh(origin: string): void } {
  const button = document.getElementById('disconnect-server');
  let shown: string | undefined;
  const refresh = (origin: string): void => {
    if (origin === shown) return;
    shown = origin;
    void paintServerEdition(origin);
  };
  button?.addEventListener('click', (event) => {
    if (!event.isTrusted || !navigator.userActivation.isActive) return;
    void (async () => {
      ports.busy(t('options_disconnectingServer', 'Disconnecting server…'));
      const response = await ports.requestDisconnect();
      shown = undefined;
      ports.render(response);
      const input = document.getElementById('server-origin') as HTMLInputElement | null;
      if (!input || input.disabled) return;
      try {
        const stored = (await chrome.storage.local.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY];
        if (typeof stored !== 'string') input.value = '';
      } catch { /* storage unavailable */ }
    })();
  });
  return { refresh };
}

export async function paintServerEdition(origin: string, fetcher?: typeof fetch): Promise<void> {
  const versionNode = document.getElementById('server-edition-version');
  const notice = document.getElementById('server-edition-notice');
  if (!versionNode || !notice) return;
  const render = Symbol(); editionRenders.set(versionNode, render);
  const originNode = document.getElementById('server-edition-origin');
  if (originNode) {
    originNode.hidden = !origin;
    originNode.textContent = origin;
  }
  const version = origin ? await fetchEditionVersion(origin, fetcher) : undefined;
  if (!versionNode.isConnected || editionRenders.get(versionNode) !== render) return;
  paintSignInHint(version);
  if (!version) {
    versionNode.textContent = t('options_serverVersionUnavailable', 'Server version unavailable');
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  versionNode.textContent = t('options_serverEdition', 'COLP Server $1', version);
  if (!isOlderThanSupportedServerMinor(version)) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }
  notice.hidden = false;
  notice.textContent = t('options_serverMinorOlder', 'This server is older than the versions this extension supports. Upgrade the server.');
}

/** Signed out, the sign-in card names the COLP Server under its address; Know-N's own server has no edition. */
function paintSignInHint(version: string | undefined): void {
  const hint = document.getElementById('login-server-hint');
  if (!hint) return;
  hint.hidden = !version;
  hint.removeAttribute('data-tone');
  if (!version) { hint.textContent = ''; return; }
  if (isOlderThanSupportedServerMinor(version)) {
    hint.dataset.tone = 'warning';
    hint.textContent = t('options_serverEditionOlder', 'COLP Server $1 is older than the versions this extension supports. Upgrade the server.', version);
  } else hint.textContent = t('options_serverEdition', 'COLP Server $1', version);
}
