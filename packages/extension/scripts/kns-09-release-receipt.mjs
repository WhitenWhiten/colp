/**
 * Compatibility entry: write the release *manifest* only.
 * Acceptance requires kns-09-acceptance-receipt.mjs + machine gate results.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [resolve(here, 'kns-09-release-manifest.mjs')], { stdio: 'inherit' });
child.on('exit', (code) => { process.exit(code ?? 1); });
