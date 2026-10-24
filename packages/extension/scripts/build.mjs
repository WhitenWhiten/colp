import { subscriptionBridgeMatches } from './subscription-bridge-config.mjs';
import { syncFormRecipe } from './sync-form-recipe.mjs';
import { syncCaptureRecipe } from './sync-capture-recipe.mjs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { syncTokens } from './sync-tokens.mjs';
import { automationAjvPlugin } from './automation-ajv-plugin.mjs';

// On by default; KNOWN_EXTENSION_CLASSIFICATION_LOCAL=false builds without the local panel.
const classificationLocal=process.env.KNOWN_EXTENSION_CLASSIFICATION_LOCAL!=='false';
const environment = process.argv[2] ?? 'production';
if (!['development', 'staging', 'production'].includes(environment)) throw new Error('Expected development, staging or production');
await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../../../scripts/generate-replica-health-limits.mjs'), '--check']);
const root = resolve(import.meta.dirname, '..'); const output = resolve(root, 'dist', environment);
await promisify(execFile)(process.execPath, [resolve(root, 'scripts/generate-bookmark-operation-validators.mjs'), '--check']);
await promisify(execFile)(process.execPath, [resolve(root, 'scripts/generate-automation-validators.mjs'), '--check']);
await promisify(execFile)(process.execPath, [resolve(root, 'scripts/generate-public-suffix.mjs'), '--check']);
const configFlag = process.argv.indexOf('--config');
if (configFlag >= 0 && (environment !== 'production' || configFlag !== 3 || process.argv.length !== 5)) {
  throw new Error('A deployment config is supported only as: build.mjs production --config <file>');
}
const configPath = configFlag < 0 ? resolve(root, 'config', `${environment}.json`) : resolve(process.argv[4]);
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.environment !== environment) throw new Error('Build environment and deployment config differ');
if (configFlag >= 0) validateProductionDeployment(config);
const evidenceEnabled = environment !== 'production' || config.deploymentId === 'e2e-fixture';
const siteEvidenceBoundary = { name: 'site-adapter-evidence-boundary', setup(plugin) {
  if (!evidenceEnabled) plugin.onLoad({ filter: /[\\/]src[\\/]site-adapters[\\/]evidence\.ts$/ }, () => ({
    contents: 'export function installSiteAdapterEvidence() {}', loader: 'ts',
  }));
} };
const bridgeMatches = subscriptionBridgeMatches(config);
await rm(output, { recursive: true, force: true }); await mkdir(resolve(output, 'icons'), { recursive: true });
await syncCaptureRecipe(resolve(output, 'capture.generated.css'));
await syncFormRecipe(resolve(output, 'forms.generated.css'));
await syncTokens({ output: resolve(output, 'tokens.generated.css') });
await build({ entryPoints: { 'service-worker': resolve(root, 'src/service-worker.ts'), options: resolve(root, 'src/entry/options.ts'),
  popup: resolve(root, 'src/entry/popup.ts'), 'capture-tabs': resolve(root, 'src/entry/capture-tabs.ts'),
  'sync-state-store': resolve(root, 'src/sync-state-store.ts'),
  'chrome-bookmark-tree': resolve(root, 'src/chrome-bookmark-tree.ts'),
  'bookmark-privacy': resolve(root, 'src/bookmark-privacy.ts'),
  'bookmark-event-queue': resolve(root, 'src/bookmark-event-queue.ts'),
  'bookmark-import-plan': resolve(root, 'src/bookmark-import-plan.ts'),
  'import-preview': resolve(root, 'src/import-preview.ts'), 'site-settings': resolve(root, 'src/site-adapters/settings.ts') },
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome121', outdir: output, plugins: [automationAjvPlugin(root), siteEvidenceBoundary], sourcemap: environment === 'production' ? false : 'external',
  // Evidence RPC (fault injection, state export) may only exist in non-production
  // builds and the e2e fixture; every real production deployment must be 'false'.
  define: { __KNOWN_EXTENSION_CLASSIFICATION_LOCAL__:String(classificationLocal), __KNOWN_EXTENSION_EVIDENCE__: environment === 'production' && config.deploymentId !== 'e2e-fixture' ? 'false' : 'true' },
  legalComments: 'none', treeShaking: true, minify: environment === 'production', charset: 'ascii' });
await build({ entryPoints: { 'site-adapter': resolve(root, 'src/site-adapters/content.ts'), 'site-probe': resolve(root, 'src/site-adapters/bilibili/probe.ts') }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome121', outdir: output, sourcemap: environment === 'production' ? false : 'external', minify: environment === 'production', legalComments: 'none' });
await Promise.all(['site-adapters.html', 'capture-tabs.html', 'options.html', 'options.css', 'welcome.css', 'popup.html', 'popup.css', 'auth.css', 'chrome.css', 'fonts.css', 'managed-storage-schema.json'].map((file) => cp(resolve(root, file), resolve(output, file))));
await cp(resolve(root, '_locales'), resolve(output, '_locales'), { recursive: true });
// One brand with the site: the popup/options/capture-tabs headers show the
// web's drawn wordmark (design/brand-wordmark.svg), not a text + mark stand-in.
await cp(resolve(root, 'design/brand-wordmark.svg'), resolve(output, 'brand-wordmark.svg'));
await cp(resolve(root, 'icons'), resolve(output, 'icons'), { recursive: true });
await mkdir(resolve(output, 'fonts'), { recursive: true });
await cp(resolve(root, 'node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2'),
  resolve(output, 'fonts/instrument-sans-latin-wght-normal.woff2'));
await cp(resolve(root, 'node_modules/@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2'),
  resolve(output, 'fonts/newsreader-latin-wght-italic.woff2'));
// The SIL Open Font License requires its text to travel with every copy of the fonts.
await cp(resolve(root, 'node_modules/@fontsource-variable/instrument-sans/LICENSE'), resolve(output, 'fonts/instrument-sans-OFL.txt'));
await cp(resolve(root, 'node_modules/@fontsource-variable/newsreader/LICENSE'), resolve(output, 'fonts/newsreader-OFL.txt'));
// The Public Suffix List is bundled from third_party/public-suffix-list under the Mozilla Public License 2.0.
await mkdir(resolve(output, 'licenses'), { recursive: true });
await cp(resolve(root, 'third_party/public-suffix-list/LICENSE'), resolve(output, 'licenses/public-suffix-list-MPL-2.0.txt'));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.base.json'), 'utf8'));
// "favicon" only exposes the read-only /_favicon/ resource to extension pages
// (bookmark manager rows) and carries no install-time warning.
if (JSON.stringify(manifest.permissions) !== JSON.stringify(['cookies', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'favicon', 'contextMenus'])
  // webNavigation is asked for only when risk alerts are switched on while browsing (doc 17 RW-17).
  || JSON.stringify(manifest.optional_permissions) !== JSON.stringify(['bookmarks', 'tabs', 'webNavigation', 'scripting'])) {
  throw new Error('manifest permission contract invalid');
}
// Required host_permissions stay the pinned Know-N server and issuer, replaced
// below. optional_host_permissions stay the manifest patterns for a runtime
// server origin; do not move the Know-N origins into that list. Local
// classification only adds its provider pattern.
if (classificationLocal) {
  const patterns = Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : [];
  manifest.optional_host_permissions = ['https://api.cloudflare.com/*', ...patterns.filter((pattern) => pattern !== 'https://api.cloudflare.com/*')];
}
if (bridgeMatches.length) manifest.externally_connectable = { matches: bridgeMatches };
manifest.host_permissions = [...new Set([`${new URL(config.serverOrigin).origin}/*`, `${new URL(config.issuer).origin}/*`])];
await writeFile(resolve(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(output, 'generated-config.json'), `${JSON.stringify(config)}\n`);

function validateProductionDeployment(value) {
  const allowed = new Set(['environment', 'deploymentId', 'extensionId', 'serverOrigin', 'manifestUrl', 'issuer',
    'authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'revocationEndpoint', 'clientId', 'audience', 'scopes',
    'allowedAlgorithms', 'refreshBeforeExpirySeconds', 'subscriptionBridgeOrigins']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Production deployment config fields are invalid');
  if (!/^[a-z0-9][a-z0-9.-]{2,63}$/u.test(value.deploymentId ?? '')
      || value.extensionId !== 'pplpnpegpnghcddhmpgkbfkdfadjiaen'
      || typeof value.clientId !== 'string' || value.clientId.length === 0
      || typeof value.audience !== 'string' || value.audience.length === 0
      || JSON.stringify(value.scopes) !== JSON.stringify(['openid', 'offline_access', 'known.sync'])
      || JSON.stringify(value.allowedAlgorithms) !== JSON.stringify(['RS256'])
      || value.refreshBeforeExpirySeconds !== 60) throw new Error('Production deployment config contract is invalid');
  const server = new URL(value.serverOrigin);
  if (server.protocol !== 'https:' || server.pathname !== '/' || server.search || server.hash) {
    throw new Error('Production deployment server origin must be exact HTTPS');
  }
  const issuer = new URL(value.issuer);
  if (issuer.protocol !== 'https:') throw new Error('Production deployment issuer must use HTTPS');
  if (new URL(value.manifestUrl).origin !== server.origin
      || ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'revocationEndpoint']
        .some((name) => new URL(value[name]).origin !== issuer.origin)) {
    throw new Error('Production deployment endpoints are not origin-bound');
  }
}
