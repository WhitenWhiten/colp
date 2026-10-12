import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

describe('P3-34 import preview static and packaged adapter contract', () => {
  test('keeps the import adapter inert: no DOM, no injection, no network or queue access', async () => {
    const source = await readFile(resolve('src/import-preview.ts'), 'utf8');
    assert.match(source, /from 'parse5'/);
    assert.match(source, /@know-n\/colp\/types/);
    assert.match(source, /\.\/generated\/import-preview-validators\.js/);
    // static-only: absence claims. A DOMParser/innerHTML path, an eval and a network or
    // queue import leave the returned preview identical, so only the source text can
    // fail when they appear. The parser/budget/format behaviour is behavioural in
    // tests/import-preview.test.ts.
    assert.doesNotMatch(source, /@know-n\/colp\/(?:src|dist|internal)/);
    assert.doesNotMatch(source, /DOMParser|innerHTML|document\.|createElement|eval\s*\(|new Function/);
    assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|chrome\.bookmarks|queue|indexedDB|console\./i);
  });

  test('ships a browser-compatible standalone adapter and a narrow pure-adapter evidence command', async () => {
    const build = await readFile(resolve('scripts/build.mjs'), 'utf8');
    const generator = await readFile(resolve('scripts/generate-bookmark-operation-validators.mjs'), 'utf8');
    const verifier = await readFile(resolve('scripts/verify-import-preview-artifact.mjs'), 'utf8');
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.match(build, /'import-preview': resolve\(root, 'src\/import-preview\.ts'\)/);
    assert.match(generator, /@know-n\/colp\/schema/);
    assert.match(generator, /import-preview-validators\.js/);
    assert.match(verifier, /import-preview\.js/);
    assert.doesNotMatch(verifier, /playwright|postgres|server/i);
    const command = pkg.scripts['evidence:phase3-import-preview'] ?? '';
    assert.match(command, /test:phase3-import-preview/);
    assert.match(command, /npm run build/);
    assert.match(command, /verify-import-preview-artifact/);
  });

  test('release security coverage scans the import adapter and excludes fixtures from MV3 artifacts', async () => {
    const security = await readFile(resolve('tests/manifest-security.test.ts'), 'utf8');
    const release = await readFile(resolve('scripts/verify-release-artifact.mjs'), 'utf8');
    assert.match(security, /src\/import-preview\.ts/);
    assert.match(release, /chrome-bookmarks-export|netscape-malicious/);
  });
});
