import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const ROOT = resolve(import.meta.dirname, '..');

describe('P3-27 release artifact contract', () => {
  test('uses minimum MV3 permissions, fixed hosts and strict CSP', async () => {
    const manifest = JSON.parse(await readFile(resolve(ROOT, 'manifest.base.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    // "favicon" only exposes the read-only /_favicon/ resource to extension
    // pages (bookmark manager rows); it carries no install-time warning.
    assert.deepEqual(manifest.permissions, ['cookies', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'favicon', 'contextMenus']);
    // webNavigation: asked for only when risk alerts are switched on while browsing (doc 17 RW-17).
    assert.deepEqual(manifest.optional_permissions, ['bookmarks', 'tabs', 'webNavigation', 'scripting']);
    assert.equal(manifest.options_ui.open_in_tab, true);
    assert.equal(manifest.storage.managed_schema, 'managed-storage-schema.json');
    assert.deepEqual(manifest.content_security_policy, { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; img-src 'self' blob: data: https:" });
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.default_locale, 'en');
    assert.equal(manifest.name, '__MSG_extensionName__');
    assert.equal(manifest.description, '__MSG_extensionDescription__');
    assert.deepEqual(manifest.action, { default_title: '__MSG_actionTitle__',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } });
    assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|unsafe-eval|unsafe-inline/);
    const build = await readFile(resolve(ROOT, 'scripts/build.mjs'), 'utf8');
    assert.match(build, /new URL\(config\.serverOrigin\)\.origin/);
    assert.match(build, /new URL\(config\.issuer\)\.origin/);
    assert.match(build, /sourcemap: environment === 'production' \? false/);
  });

  test('accepts hashed options and popup pages as extension senders', async () => {
    const source = await readServiceWorkerGraph(ROOT);
    assert.match(source, /page = new URL\(sender\.url\)/);
    assert.match(source, /page\.pathname === '\/options\.html'/);
    assert.match(source, /page\.pathname === '\/popup\.html'/);
    assert.match(source, /ensureFreshCredential/);
    assert.match(source, /library_unavailable/);
    assert.match(source, /colpCredentialHeaders\(credential\.accessToken\)/);
    assert.doesNotMatch(source, /sender\.url === `chrome-extension:\/\/\$\{chrome\.runtime\.id\}\/(?:options|popup)\.html`/);
  });

  test('contains no remote code, dynamic evaluation, secret or credential logging path', async () => {
    const files = ['src/options.ts', 'src/popup.ts', 'src/auth-controller.ts', 'src/auth-client.ts',
      'src/login-form.ts', 'src/manifest-client.ts', 'src/import-preview.ts'];
    const source = `${await readServiceWorkerGraph(ROOT)}\n${(await Promise.all(files.map((file) => readFile(resolve(ROOT, file), 'utf8')))).join('\n')}`;
    assert.doesNotMatch(source, /eval\s*\(|new Function|document\.write|innerHTML\s*=|console\.(log|debug|info)/);
    assert.doesNotMatch(source, /client[_-]?secret/i);
    assert.doesNotMatch(source, /window\.postMessage|content_scripts/); // dedicated runtime Port only
  });
});
