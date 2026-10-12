#!/usr/bin/env node
/* Every var(--token) in extension css must resolve to a definition: the web
   tokens.css :root (design/tokens.css, synced into dist/tokens.generated.css at build time), a
   definition in the extension's own css, or a custom property the TypeScript
   sets at runtime (e.g. style.setProperty('--depth', …)). dist/ is gitignored,
   so a web-side token rename would otherwise surface only as missing styling. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensCss = readFileSync(resolve(root, 'design/tokens.css'), 'utf8');

const defined = new Set();
for (const match of tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);

const cssFiles = readdirSync(root).filter((file) => file.endsWith('.css'));
for (const file of cssFiles) {
  for (const match of readFileSync(resolve(root, file), 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
}

for (const file of readdirSync(resolve(root, 'src')).filter((name) => name.endsWith('.ts'))) {
  const text = readFileSync(resolve(root, 'src', file), 'utf8');
  for (const match of text.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)['"]/g)) defined.add(match[1]);
  for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
}

const missing = new Set();
for (const file of cssFiles) {
  for (const match of readFileSync(resolve(root, file), 'utf8').matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (!defined.has(match[1])) missing.add(`${file}: ${match[1]}`);
  }
}
if (missing.size > 0) {
  console.error('check:tokens failed — extension css references tokens that resolve to nothing:');
  for (const entry of missing) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`check:tokens ok (${cssFiles.length} css files scanned)`);
