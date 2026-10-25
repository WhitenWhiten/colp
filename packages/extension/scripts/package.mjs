// Build the production extension, scan it, and zip dist/production with its files
// at the zip root (the layout the Chrome Web Store and "Load unpacked" expect).
// Prints the zip path. The store upload itself is manual.
import { execFile } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkReleaseVersion } from './release-version.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist/production');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.base.json'), 'utf8'));
checkReleaseVersion(version, manifest);

await run(process.execPath, [resolve(root, 'scripts/build.mjs'), 'production'], { cwd: root });
await run(process.execPath, [resolve(root, 'scripts/verify-release-artifact.mjs'), dist], { cwd: root });

const zip = resolve(root, 'dist', `known-extension-${version}.zip`);
await rm(zip, { force: true });
const entries = (await readdir(dist)).sort();
// Python's zipfile is on every Linux and macOS runner; Node has no zip writer.
await run('python3', ['-m', 'zipfile', '-c', zip, ...entries], { cwd: dist });
process.stdout.write(`${zip}\n`);
