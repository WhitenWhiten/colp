import type { AuthorityContext } from '../authority-fence.js';
import { RUNTIME_ORIGIN_KEY } from '../config.js';
import { disconnectServer } from '../server-disconnect.js';
import type { ExtensionResponse } from '../types.js';
import { handle } from './auth.js';
import { stopSyncEngine } from './engine.js';
import { store } from './runtime.js';
import { createRuntimeAuth, loadConfig } from './scope.js';

export { validServerDisconnectRequest } from '../server-disconnect.js';

export async function handleServerDisconnect(context: AuthorityContext, nextOrigin?: string): Promise<ExtensionResponse> {
  let response: ExtensionResponse | undefined;
  await disconnectServer({
    stopSyncEngine,
    async signOut() {
      response = await handle({ kind: 'known.auth.logout', userGesture: true }, context);
    },
    clearSession() {
      return store.clearSession();
    },
    async readRuntimeOrigin() {
      const stored = await chrome.storage.local.get(RUNTIME_ORIGIN_KEY);
      const value = stored[RUNTIME_ORIGIN_KEY];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    clearRuntimeOrigin() {
      return chrome.storage.local.remove(RUNTIME_ORIGIN_KEY);
    },
    async readManagedPolicy() {
      try {
        return await chrome.storage.managed.get(['serverOrigin']);
      } catch {
        return {};
      }
    },
  }, nextOrigin);
  const config = await loadConfig();
  if (response) return { ...response, state: { ...response.state, serverOrigin: config.serverOrigin, environment: config.environment } };
  return { ok: true, state: await createRuntimeAuth(config).status() };
}
