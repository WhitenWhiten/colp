import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/production');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path); else files.push(path);
  }
}
await walk(root);
assert.ok(files.some((file) => file.endsWith('manifest.json')));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const config = JSON.parse(await readFile(resolve(root, 'generated-config.json'), 'utf8'));
assert.deepEqual(manifest.permissions, ['cookies', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'favicon', 'contextMenus'], 'release required permissions changed');
// webNavigation: risk alerts while browsing are optional and requested with tabs
// (doc 17 RW-17, risk-settings.ts BROWSE_PERMISSIONS).
assert.deepEqual(manifest.optional_permissions, ['bookmarks', 'tabs', 'webNavigation', 'scripting'], 'release optional permissions changed');
assert.deepEqual(manifest.host_permissions, [...new Set([
  `${new URL(config.serverOrigin).origin}/*`, `${new URL(config.issuer).origin}/*`,
])], 'release host permissions changed');
// A runtime server origin is requested on save from these optional patterns.
// Local classification may prefix its provider pattern. An opt-out build keeps
// only the two server patterns. Required host_permissions stay the pinned
// Know-N origins and are not moved here.
const serverHostPatterns = ['https://*/*', 'http://*/*'];
const optionalHosts = manifest.optional_host_permissions;
if (Array.isArray(optionalHosts) && optionalHosts[0] === 'https://api.cloudflare.com/*') {
  assert.deepEqual(optionalHosts, ['https://api.cloudflare.com/*', ...serverHostPatterns],
    'release optional host permissions changed');
} else {
  assert.deepEqual(optionalHosts, serverHostPatterns, 'release optional host permissions changed');
}
for (const bundle of ['site-adapter.js', 'site-probe.js']) {
  const code = await readFile(resolve(root, bundle), 'utf8');
  new Script(code, { filename: bundle }); // classic-script grammar, no unresolved ESM
  assert.doesNotMatch(code, /import\s*\(|https?:\/\/[^'" ]+\.js/);
}
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(files.some((file) => file.endsWith('.map')), false, 'release source maps are forbidden');
for (const fixture of ['indexeddb-p3-03', 'indexeddb-p3-27']) {
  assert.equal(files.some((file) => file.includes(fixture)), false, `release contains test fixture ${fixture}`);
}
for (const fixture of ['chrome-bookmarks-export', 'netscape-malicious']) {
  assert.equal(files.some((file) => file.includes(fixture)), false, `release contains import fixture ${fixture}`);
}
if (config.deploymentId !== 'e2e-fixture') assert.ok(!(await readFile(resolve(root, 'service-worker.js'), 'utf8')).includes('known.siteAdapters.evidence'), 'release contains site-adapter evidence RPC');
const markers = [/client[_-]?secret/i, /fixture-access|fixture-refresh/i, /TEST[_-]?TOKEN/i, /SYNC-SECRET-MARKER/i,
  /PRIVATE-LOCAL-SENTINEL|PRIVATE-QUEUE-SENTINEL|UNSELECTED-SENTINEL|UNSELECTED-QUEUE-SENTINEL|PROFILE-[AB]-(?:PRIVATE|UNSELECTED)-SENTINEL|native-sensitive-id|https:\/\/sentinel\.invalid\/(?:private(?:-queue)?|unselected-queue|profile-[ab]-(?:private|unselected))/i,
  /postgres(?:ql)?:\/\//i, /\\Users\\|\/home\//i, /eval\s*\(|new Function|https?:\/\/localhost/i];
for (const file of files) {
  const content = await readFile(file, 'utf8').catch(() => '');
  for (const marker of markers) assert.doesNotMatch(content, marker, `${relative(root, file)} contains ${marker}`);
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifact: 'chromium-mv3', files: files.length,
  sourceMaps: false, secretScan: 'passed', runtimeChecksRequired: true }, null, 2)}\n`);
