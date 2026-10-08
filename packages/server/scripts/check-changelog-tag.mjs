// Stdout is the matching CHANGELOG section so the release workflow can use it
// as the GitHub release body. Diagnostics go to stderr.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = 'colp-server-v';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const tag = process.argv[2];
if (process.argv.length !== 3 || !tag || tag.startsWith('-')) {
  fail('usage: check-changelog-tag.mjs colp-server-vX.Y.Z');
}
if (!tag.startsWith(prefix)) fail(`tag must start with ${prefix}`);
const version = tag.slice(prefix.length);
if (!versionPattern.test(version)) fail(`tag version must be X.Y.Z: ${tag}`);

const changelogPath = resolve(dirname(fileURLToPath(import.meta.url)), '../CHANGELOG.md');
let text;
try {
  text = readFileSync(changelogPath, 'utf8');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`cannot read ${changelogPath}: ${message}`);
}

const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s.*)?$`);
const lines = text.split(/\r?\n/);
const starts = [];
for (let index = 0; index < lines.length; index += 1) {
  if (heading.test(lines[index])) starts.push(index);
}
if (starts.length === 0) fail(`no CHANGELOG section for ${version}`);
if (starts.length > 1) fail(`more than one CHANGELOG section for ${version}`);

const start = starts[0];
let end = lines.length;
for (let index = start + 1; index < lines.length; index += 1) {
  if (lines[index].startsWith('## ')) {
    end = index;
    break;
  }
}
process.stdout.write(`${lines.slice(start, end).join('\n').trimEnd()}\n`);

function fail(message) {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
