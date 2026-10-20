import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import { readServiceWorkerGraph } from './service-worker-graph.js';

/**
 * Static privacy/boundary contract (allowlisted in tests/static-anchor-allowlist.ts):
 * what must *not* cross a module edge (native ids, urls, chrome.bookmarks in the
 * options/range UI), the manifest permission split, trusted-gesture-only permission
 * mutation and the release-scanner sentinel list. Root behaviour is covered by
 * tests/bookmark-roots.test.ts and tests/scope-range.test.ts.
 */
describe('P3-29 static privacy and worker boundary contract', () => {
  test('keeps Chrome tree access in the worker and exposes only a narrow redacted protocol', async () => {
    const worker = await readServiceWorkerGraph();
    const options = await readFile(resolve('src/options.ts'), 'utf8');
    const types = await readFile(resolve('src/types.ts'), 'utf8');
    const rootOptions = options.slice(options.indexOf('async function loadRoots'));
    const rootTypes = types.slice(types.indexOf('export interface PublicRootNode'),
      types.indexOf('export type ExtensionRequest'));
    assert.match(worker, /createChromeBookmarkTreeAdapter/);
    assert.doesNotMatch(rootOptions, /chrome\.bookmarks|nativeId|\.url\b/);
    assert.match(types, /known\.roots\.(?:get|update|preview|confirm)/);
    assert.doesNotMatch(rootTypes, /nativeId|bookmarkUrl|readonly url/);
    const rangeUi = await readFile(resolve('src/range-ui.ts'), 'utf8');
    const optionsHtml = await readFile(resolve('options.html'), 'utf8');
    assert.doesNotMatch(rangeUi, /chrome\.bookmarks|nativeId|\.url\b/);
    assert.match(rangeUi, /known\.roots\.preview/);
    assert.match(rangeUi, /known\.roots\.confirm/);
    assert.match(optionsHtml, /Confirm folder changes/);
    assert.match(rangeUi, /Also move Know-N copies to trash|range-remote-delete/);
  });

  test('keeps bookmarks optional and permission mutations in trusted options gestures', async () => {
    const manifest = JSON.parse(await readFile(resolve('manifest.base.json'), 'utf8')) as Record<string, unknown>;
    const worker = await readServiceWorkerGraph();
    const options = `${await readFile(resolve('src/options.ts'), 'utf8')}\n${await readFile(resolve('src/sync-import.ts'), 'utf8')}`;
    const permissionSettings = await readFile(resolve('src/permissions-settings.ts'), 'utf8');
    const types = await readFile(resolve('src/types.ts'), 'utf8');
    assert.deepEqual(manifest.permissions, ['cookies', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'favicon', 'contextMenus']);
    assert.deepEqual(manifest.optional_permissions, ['bookmarks', 'tabs', 'webNavigation']);
    assert.match(options, /chrome\.permissions\.contains/);
    assert.match(options, /chrome\.permissions\.request/);
    assert.match(permissionSettings, /chrome\.permissions\[operation\]/);
    assert.match(permissionSettings, /'request' \| 'remove'/);
    assert.match(permissionSettings, /event\.isTrusted && navigator\.userActivation\.isActive/);
    assert.match(options, /event\.isTrusted.*navigator\.userActivation\.isActive/s);
    const loginForm = await readFile(resolve('src/login-form.ts'), 'utf8');
    assert.match(loginForm, /!event\.isTrusted \|\| !navigator\.userActivation\.isActive/u);
    assert.match(types, /known\.roots\.permissionChanged/);
    assert.match(types, /userGesture: true/);
    assert.match(worker, /resumeBookmarksAfterPermissionGrant[\s\S]{0,400}scheduleSyncEngineWake\('manual'\)/);
    const roots = await readFile(resolve('src/sw/roots.ts'), 'utf8');
    assert.match(roots, /priorStatus === 'permission_required'[\s\S]{0,240}recoverBookmarkEvents\(\)/u);
    assert.match(worker, /chrome\.permissions\.contains/);
    assert.doesNotMatch(worker, /chrome\.permissions\.(?:request|remove)/);
  });

  test('places privacy before operation/network/log construction and has no second root authority', async () => {
    const privacy = await readFile(resolve('src/bookmark-privacy.ts'), 'utf8');
    const source = (await Promise.all(['src/chrome-bookmark-tree.ts', 'src/bookmark-privacy.ts']
      .map((file) => readFile(resolve(file), 'utf8')))).join('\n');
    assert.match(privacy, /allowOperationCandidate/);
    assert.doesNotMatch(source, /console\.(?:log|debug|info|warn|error)|telemetry|analytics/);
    assert.doesNotMatch(source, /chrome\.storage\.(?:local|sync)|localStorage/si);
  });

  test('release scanner rejects bookmark sentinel data and build includes only production adapters', async () => {
    const build = await readFile(resolve('scripts/build.mjs'), 'utf8');
    const worker = await readServiceWorkerGraph();
    const scanner = await readFile(resolve('scripts/verify-release-artifact.mjs'), 'utf8');
    const privacyScanner = await readFile(resolve('scripts/verify-bookmark-privacy-artifacts.mjs'), 'utf8');
    assert.match(build, /chrome-bookmark-tree|bookmark-privacy/);
    for (const marker of ['PRIVATE-LOCAL-SENTINEL', 'UNSELECTED-SENTINEL', 'PROFILE-', 'native-sensitive-id']) assert.match(scanner,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(scanner, /sentinel\\\.invalid/);
    assert.match(worker, /viewId.*scopeKey|scopeKey.*viewId/s);
    assert.match(worker, /sameDiscovered/);
    assert.match(privacyScanner, /PRIVATE-LOCAL-SENTINEL|UNSELECTED-SENTINEL/);
    assert.match(privacyScanner, /network|trace|screenshot|storage/i);
  });

  test('production E2E requires real permission transitions and two persistent profile directories', async () => {
    const e2e = await readFile(resolve('e2e/mv3-bookmark-roots.spec.ts'), 'utf8');
    const permission = await readFile(resolve('e2e/bookmark-permission.ts'), 'utf8');
    assert.match(e2e, /permissions\.contains/);
    assert.match(e2e, /Remove bookmark access/);
    assert.match(e2e, /known\.roots\.get/);
    assert.match(e2e, /known-p3-29-profile-a-/);
    assert.match(e2e, /known-p3-29-profile-b-/);
    assert.match(e2e, /launch\(profileA\).*launch\(profileB\)/s);
    assert.match(e2e, /terminateExtensionWorker\(contextA.*terminateExtensionWorker\(contextB/s);
    assert.doesNotMatch(e2e, /fake-indexeddb|new IDBFactory|\.addInitScript/);
    assert.match(permission, /Promise\.allSettled/);
    assert.match(permission, /requireXdotool[\s\S]*xdotool[\s\S]*--version/);
    assert.match(permission, /process\.platform === 'linux'[\s\S]{0,100}grantBookmarksPermissionX11/);
    // Permission truth/denial is exercised through the actual grant helper in
    // bookmark-permission-grant.test.ts; source declaration order is irrelevant.
  });
});
