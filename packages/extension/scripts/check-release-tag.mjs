// Checks an extension-vX.Y.Z[-rc.N] tag against package.json, manifest.base.json and
// CHANGELOG.md. Stdout is the matching CHANGELOG section, which the release
// workflow uses as the GitHub release body. Diagnostics go to stderr.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkReleaseVersion } from './release-version.mjs';

const prefix = 'extension-v';
const root = resolve(import.meta.dirname, '..');
const tag = process.argv[2];
if (process.argv.length !== 3 || !tag?.startsWith(prefix)) fail(`usage: check-release-tag.mjs ${prefix}X.Y.Z[-rc.N]`);
const version = tag.slice(prefix.length);

const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (packageVersion !== version) fail(`package.json is ${packageVersion}, tag is ${version}`);
try {
  checkReleaseVersion(version, JSON.parse(readFileSync(resolve(root, 'manifest.base.json'), 'utf8')));
} catch (error) {
  fail(error.message);
}

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
