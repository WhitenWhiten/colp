/**
 * @vitest-environment happy-dom
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import { isOlderThanSupportedServerMinor, SUPPORTED_SERVER_MINORS } from '../src/config.js';
import { disconnectServer, validServerDisconnectRequest, type ServerDisconnectPorts } from '../src/server-disconnect.js';
import { readEditionVersion } from '../src/server-edition.js';
import { paintServerEdition } from '../src/server-account-ui.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('supported server minor', () => {
  test('the extension supports two minors and notices an older one', () => {
    assert.deepEqual([...SUPPORTED_SERVER_MINORS], [1, 2]);
    assert.equal(isOlderThanSupportedServerMinor('0.0.9'), true);
    assert.equal(isOlderThanSupportedServerMinor(' 0.0.0 '), true);
    assert.equal(isOlderThanSupportedServerMinor('0.1.0'), false);
    assert.equal(isOlderThanSupportedServerMinor('0.1'), false);
    assert.equal(isOlderThanSupportedServerMinor('0.2.3'), false);
    assert.equal(isOlderThanSupportedServerMinor('0.3.0'), false);
    assert.equal(isOlderThanSupportedServerMinor('1.0.0'), false);
    assert.equal(isOlderThanSupportedServerMinor('nope'), false);
    assert.equal(isOlderThanSupportedServerMinor(''), false);
  });

  test('edition version is read from manifest features', () => {
    assert.equal(readEditionVersion({
      mounts: [{ features: { cloud: false, edition: { name: 'colp-server', version: '0.1.0' } } }],
    }), '0.1.0');
    assert.equal(readEditionVersion({
      features: { edition: { name: 'colp-server', version: '0.2.0' } },
    }), '0.2.0');
    assert.equal(readEditionVersion({ mounts: [{ features: { cloud: false } }] }), undefined);
    assert.equal(readEditionVersion(null), undefined);
    assert.equal(readEditionVersion({ mounts: [{ 'https://know-n.com/colp/extensions/server': { edition: { version: '0.1.0' } } }] }), '0.1.0');
  });
});

describe('disconnect server', () => {
  test('accepts exact replacement origins only on a user gesture', () => {
    const base = { kind: 'known.server.disconnect', userGesture: true };
    assert.equal(validServerDisconnectRequest(base), true);
    for (const nextOrigin of ['https://colp.example.net:8443', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
      assert.equal(validServerDisconnectRequest({ ...base, nextOrigin }), true);
    }
    for (const nextOrigin of ['', 'http://192.168.1.20', 'https://colp.example.net/path', 'https://u:p@colp.example.net', 'file:///tmp', 'x'.repeat(2049)]) {
      assert.equal(validServerDisconnectRequest({ ...base, nextOrigin }), false);
    }
    assert.equal(validServerDisconnectRequest({ ...base, userGesture: false }), false);
    assert.equal(validServerDisconnectRequest({ ...base, other: true }), false);
  });
  const origin = 'https://colp.example.net';
  const bookmarks = Object.freeze([{ id: 'b1', title: 'Stay', url: 'https://example.com/stay' }]);

  function harness(managed: Readonly<Record<string, unknown>> = {}): {
    calls: string[];
    storage: Record<string, unknown>;
    permissionsRemove: ReturnType<typeof vi.fn>;
    bookmarkRemove: ReturnType<typeof vi.fn>;
    ports: ServerDisconnectPorts;
  } {
    const calls: string[] = [];
    const storage: Record<string, unknown> = { runtimeServerOrigin: origin, bookmarks };
    const permissionsRemove = vi.fn(async () => true);
    const bookmarkRemove = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      permissions: { remove: permissionsRemove },
      bookmarks: { remove: bookmarkRemove, removeTree: bookmarkRemove, getTree: vi.fn(async () => bookmarks) },
    });
    const ports: ServerDisconnectPorts = {
      async stopSyncEngine() { calls.push('stop'); },
      async signOut() { calls.push('signOut'); },
      async clearSession() { calls.push('clearSession'); },
      async readRuntimeOrigin() {
        const value = storage.runtimeServerOrigin;
        return typeof value === 'string' ? value : undefined;
      },
      async clearRuntimeOrigin() {
        calls.push('clearOrigin');
        delete storage.runtimeServerOrigin;
      },
      async readManagedPolicy() { return managed; },
    };
    return { calls, storage, permissionsRemove, bookmarkRemove, ports };
  }

  test('clears the runtime origin and releases only that host permission', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/server-disconnect.ts'), 'utf8');
    assert.equal(source.includes('chrome.bookmarks'), false);
    const { calls, storage, permissionsRemove, bookmarkRemove, ports } = harness();
    await disconnectServer(ports);
    assert.deepEqual(calls, ['stop', 'signOut', 'clearSession', 'clearOrigin']);
    assert.equal(storage.runtimeServerOrigin, undefined);
    assert.equal(storage.bookmarks, bookmarks);
    assert.deepEqual(permissionsRemove.mock.calls, [[{ origins: [`${origin}/*`] }]]);
    assert.equal(bookmarkRemove.mock.calls.length, 0);
  });

  test('a managed origin stays and only signs out', async () => {
    const { calls, storage, permissionsRemove, bookmarkRemove, ports } = harness({ serverOrigin: 'https://policy.example' });
    await disconnectServer(ports);
    assert.deepEqual(calls, ['signOut']);
    assert.equal(storage.runtimeServerOrigin, origin);
    assert.equal(storage.bookmarks, bookmarks);
    assert.equal(permissionsRemove.mock.calls.length, 0);
    assert.equal(bookmarkRemove.mock.calls.length, 0);
  });

  test('changing a server port preserves the optional host grant for its replacement', async () => {
    const { calls, permissionsRemove, ports } = harness();
    await disconnectServer(ports, 'https://colp.example.net:8443');
    assert.deepEqual(calls, ['stop', 'signOut', 'clearSession', 'clearOrigin']);
    assert.equal(permissionsRemove.mock.calls.length, 0);
  });

  test('changing to another host releases the previous host grant', async () => {
    const { permissionsRemove, ports } = harness();
    await disconnectServer(ports, 'https://other.example.net');
    assert.deepEqual(permissionsRemove.mock.calls, [[{ origins: [`${origin}/*`] }]]);
  });
});

describe('account edition notice', () => {
  test('shows the manifest version and a notice only when the minor is older', async () => {
    document.body.innerHTML = '<p id="server-edition-version"></p><p id="server-edition-origin" hidden></p><p id="server-edition-notice" hidden></p><p id="login-server-hint" hidden></p>';
    const manifest = (version: string) => async () => new Response(JSON.stringify({
      mounts: [{ features: { edition: { name: 'colp-server', version } } }],
    }), { status: 200 });
    await paintServerEdition('https://colp.example.net', manifest('0.0.4') as typeof fetch);
    assert.equal(document.getElementById('server-edition-version')!.textContent, 'COLP Server 0.0.4');
    // The row names the server it is connected to under its edition.
    assert.equal(document.getElementById('server-edition-origin')!.textContent, 'https://colp.example.net');
    assert.equal(document.getElementById('server-edition-origin')!.hidden, false);
    const notice = document.getElementById('server-edition-notice')!;
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent ?? '', /older than the versions this extension supports/);
    // Signed out, the sign-in card says the same under the Server field.
    const hint = document.getElementById('login-server-hint')!;
    assert.equal(hint.hidden, false);
    assert.equal(hint.dataset.tone, 'warning');
    assert.match(hint.textContent ?? '', /^COLP Server 0\.0\.4 is older than/);
    await paintServerEdition('https://colp.example.net', manifest('0.1.0') as typeof fetch);
    assert.equal(document.getElementById('server-edition-version')!.textContent, 'COLP Server 0.1.0');
    assert.equal(document.getElementById('server-edition-notice')!.hidden, true);
    assert.equal(hint.textContent, 'COLP Server 0.1.0');
    assert.equal(hint.dataset.tone, undefined);
    // Know-N's own server publishes no edition: no hint.
    await paintServerEdition('https://know-n.com', (async () => new Response('{}', { status: 200 })) as typeof fetch);
    assert.equal(hint.hidden, true);
  });
});
