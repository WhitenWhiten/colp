import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/production');
const path = resolve(root, 'import-preview.js');
assert.equal((await stat(path)).isFile(), true, 'import-preview.js is missing');
const source = await readFile(path, 'utf8');
for (const marker of ['netscape-bookmarks-v1', 'chromium-bookmarks-v1', 'duplicate_candidate',
  'input_too_large', 'chrome_tree_invalid', 'unsupported_format', 'import_empty']) {
  assert.ok(source.includes(marker), `import adapter is missing ${marker}`);
}
assert.doesNotMatch(source, /DOMParser|innerHTML|document\.write|eval\s*\(|new Function|XMLHttpRequest|chrome\.bookmarks|indexedDB|console\.(?:log|debug|info)/);
assert.doesNotMatch(source, /(?:from\s*["'](?:node:)?(?:crypto|util(?:\/types)?)["']|require\(["'](?:node:)?(?:crypto|util(?:\/types)?)["']\))/);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, artifact: 'chromium-mv3-import-preview',
  adapter: 'pure', network: false, storage: false, domInjection: false }, null, 2)}\n`);
