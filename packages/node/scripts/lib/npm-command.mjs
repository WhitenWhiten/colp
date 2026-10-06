import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/** Run npm through Node, without shell interpolation (including on Windows). */
export async function runNpm(args, cwd, options = {}) {
  const candidates = [process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  let cli;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.endsWith('npm-cli.js')) continue;
    try { await access(candidate); cli = candidate; break; } catch { /* try the next standard location */ }
  }
  if (cli === undefined) throw new Error('Cannot locate npm-cli.js; invoke this script through npm exec.');
  return exec(process.execPath, [cli, ...args], { cwd, env: isolatedProcessEnvironment(),
    timeout: options.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 });
}

export function isolatedProcessEnvironment() {
  const environment = { ...process.env, npm_config_ignore_scripts: 'true', npm_config_global: 'false' };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  return environment;
}
