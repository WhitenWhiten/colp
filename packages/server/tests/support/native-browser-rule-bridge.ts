import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium, type BrowserContext } from 'playwright';
import type { BrowserRequest, BrowserRequestResult } from '../../../extension/src/automation/device-bridge.js';

/** Test-only extension: production bridge executor, journal and Chrome APIs; no provider or account keys. */
export async function nativeBrowserRuleBridge() {
  if (!process.env.DISPLAY) throw new Error('This browser integration test requires xvfb-run.');
  const root = fileURLToPath(new URL('../../../extension/', import.meta.url));
  const require = createRequire(resolve(root, 'package.json'));
  const { build } = require('esbuild') as typeof import('esbuild');
  const { automationAjvPlugin } = await import(new URL('../../../extension/scripts/automation-ajv-plugin.mjs', import.meta.url).href);
  const directory = await mkdtemp(resolve(tmpdir(), 'mcp-browser-chain-'));
  let context: BrowserContext | undefined;
  try {
    await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'MCP browser chain test', version: '1.0',
      permissions: ['bookmarks','storage','unlimitedStorage','alarms'], background: { service_worker: 'worker.js', type: 'module' } }));
    await build({ stdin: { resolveDir: root, contents: `
      import { handleBrowserRulesBridge } from './src/sw/device-bridge-browser-rules.ts';
      import { createDeviceBridgeRunner } from './src/automation/device-bridge.ts';
      import { automationDatabase } from './src/automation/indexeddb-store.ts';
      globalThis.runMcpBrowserFixture = async (requests, replicaId, collectionId) => {
        const results = [];
        const authorize = async request => {
          if (request.replicaId !== replicaId || request.collectionId !== collectionId) throw Error('device_scope_changed');
        };
        await createDeviceBridgeRunner(automationDatabase().area(), {
          authorize,
          execute: request => handleBrowserRulesBridge(request, () => authorize(request)),
          complete: async result => { results.push(result); return 'retry'; }
        })(requests);
        return results;
      };
      chrome.runtime.onInstalled.addListener(() => {});
    ` }, bundle: true, format: 'esm', platform: 'browser', target: 'chrome121', outfile: resolve(directory, 'worker.js'),
      plugins: [automationAjvPlugin(root)], define: { __KNOWN_EXTENSION_EVIDENCE__: 'false', __KNOWN_EXTENSION_CLASSIFICATION_LOCAL__: 'false' } });
    context = await chromium.launchPersistentContext(resolve(directory, 'profile'), { headless: false, channel: 'chromium',
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`] });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const folders = await worker.evaluate<{ root: string; inbox: string; destination: string }>(`(async () => {
      const root = (await chrome.bookmarks.getTree())[0].children.find(n => !n.url).id;
      const inbox = await chrome.bookmarks.create({ parentId: root, title: 'Inbox' });
      const destination = await chrome.bookmarks.create({ parentId: root, title: 'Papers' });
      await chrome.bookmarks.create({ parentId: inbox.id, title: 'Paper', url: 'https://arxiv.org/abs/test' });
      await chrome.bookmarks.create({ parentId: inbox.id, title: 'Blog', url: 'https://example.test/blog' });
      return { root, inbox: inbox.id, destination: destination.id };
    })()`);
    return { ...folders,
      run: (requests: BrowserRequest[], replicaId: string, collectionId: string) => worker.evaluate(
        ({ requests, replicaId, collectionId }) => (globalThis as unknown as { runMcpBrowserFixture: (r: BrowserRequest[], replica: string, collection: string) => Promise<BrowserRequestResult[]> })
          .runMcpBrowserFixture(requests, replicaId, collectionId), { requests, replicaId, collectionId }),
      children: (id: string) => worker.evaluate<string[]>(`chrome.bookmarks.getChildren(${JSON.stringify(id)}).then(nodes => nodes.map(n => n.title))`),
      close: async () => { try { await context?.close(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) { await context?.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
