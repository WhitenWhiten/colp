/**
 * `./sync/browser` is importable by a browser-targeted bundler without Node
 * polyfills and exposes the same function objects as `./sync`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import * as browserApi from '../../src/sync/browser.js';
import * as canonicalApi from '../../src/sync/canonical.js';
import * as syncApi from '../../src/sync/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const distSyncDir = join(packageRoot, 'dist/sync');

async function bundleForBrowser(entry: string) {
  return build({
    entryPoints: [join(packageRoot, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    logLevel: 'silent',
  });
}

function distImportGraph(entry: string): readonly string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/gu)) {
      stack.push(join(dirname(file), match[1]!));
    }
  }
  return [...seen];
}

describe('browser-safe ./sync/browser entry', () => {
  it('bundles for platform=browser with no Node built-ins, polyfills or Buffer', async () => {
    const result = await bundleForBrowser('src/sync/browser.ts');
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some(input => input.startsWith('node:') || input.includes('immutable-json'))).toBe(false);
    const output = result.outputFiles[0]!.text;
    expect(output).not.toMatch(/\bBuffer\b/u);
    expect(output).not.toMatch(/\brequire\(/u);
    expect(output).not.toMatch(/["']node:/u);
  });

  it('has teeth: the Node-oriented ./sync barrel does not bundle for the browser', async () => {
    await expect(bundleForBrowser('src/sync/index.ts')).rejects.toThrow(/node:/u);
  });

  it('exposes the same function objects as ./sync and all of ./sync/canonical', () => {
    for (const [name, value] of Object.entries(canonicalApi)) {
      expect(browserApi[name as keyof typeof browserApi], name).toBe(value);
    }
    const sync = syncApi as Record<string, unknown>;
    for (const [name, value] of Object.entries(browserApi)) {
      if (name in sync) expect(sync[name], name).toBe(value);
      else expect(name in canonicalApi, `${name} must come from ./sync/canonical`).toBe(true);
    }
    for (const name of ['applySyncBrowserBatch', 'translateSyncBrowserEvent', 'parseNetscapeBookmarkHtml',
      'establishSyncRootMapping', 'persistSyncSidecar', 'utf8JsonByteLength', 'canonicalOperationDigest'] as const) {
      expect(typeof browserApi[name], name).toBe('function');
    }
  });

  it('keeps coordinators, Pull validators and Proxy-guarded merges off the browser entry', () => {
    for (const name of ['createSyncHost', 'coordinateSessionBoundPull', 'validateAuthoritativePullEventPage',
      'mergeSyncTypedUpdate', 'requireVerifiedSyncSession']) {
      expect(name in browserApi, name).toBe(false);
    }
  });

  it('is published in the export map and tsup entries', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      readonly exports: Record<string, unknown>;
    };
    expect(packageJson.exports['./sync/browser']).toEqual({
      types: { import: './dist/sync/browser.d.ts', require: './dist/sync/browser.d.cts' },
      import: './dist/sync/browser.js',
      require: './dist/sync/browser.cjs',
    });
    expect(readFileSync(join(packageRoot, 'tsup.config.ts'), 'utf8'))
      .toMatch(/['"]sync\/browser['"]\s*:\s*['"]src\/sync\/browser\.ts['"]/u);
  });

  it.skipIf(!existsSync(join(distSyncDir, 'browser.js')))(
    'when dist/ exists, the built ESM graph has no Node built-ins and CJS loads',
    async () => {
      const graph = distImportGraph(join(distSyncDir, 'browser.js'));
      for (const file of graph) {
        const source = readFileSync(file, 'utf8');
        expect(source, file).not.toMatch(/\bfrom ['"]node:|require\(['"]node:|\bBuffer\b/u);
      }
      const esm = (await import(join(distSyncDir, 'browser.js'))) as Record<string, unknown>;
      const cjs = createRequire(import.meta.url)(join(distSyncDir, 'browser.cjs')) as Record<string, unknown>;
      expect(Object.keys(esm).sort()).toEqual(Object.keys(browserApi).sort());
      expect(Object.keys(cjs).sort()).toEqual(Object.keys(browserApi).sort());
    },
  );
});
