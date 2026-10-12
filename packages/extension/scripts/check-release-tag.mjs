// Checks an extension-vX.Y.Z tag against package.json, manifest.base.json and
// CHANGELOG.md. Stdout is the matching CHANGELOG section, which the release
// workflow uses as the GitHub release body. Diagnostics go to stderr.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prefix = 'extension-v';
const root = resolve(import.meta.dirname, '..');
const tag = process.argv[2];
if (process.argv.length !== 3 || !tag?.startsWith(prefix)) fail(`usage: check-release-tag.mjs ${prefix}X.Y.Z`);
const version = tag.slice(prefix.length);
// Chrome manifest versions are one to four dot-separated integers; no pre-release suffix.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) fail(`tag version must be X.Y.Z: ${tag}`);

const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const manifestVersion = JSON.parse(readFileSync(resolve(root, 'manifest.base.json'), 'utf8')).version;
if (packageVersion !== version) fail(`package.json is ${packageVersion}, tag is ${version}`);
if (manifestVersion !== version) fail(`manifest.base.json is ${manifestVersion}, tag is ${version}`);

const lines = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/u);
const heading = `## [${version}]`;
const starts = lines.flatMap((line, index) => (line === heading || line.startsWith(`${heading} `) ? [index] : []));
if (starts.length !== 1) fail(`CHANGELOG.md needs exactly one ${heading} section`);
const start = starts[0];
const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
process.stdout.write(`${lines.slice(start, next < 0 ? lines.length : next).join('\n').trimEnd()}\n`);

function fail(message) {
  console.error(`extension release: ${message}`);
  process.exit(1);
}
