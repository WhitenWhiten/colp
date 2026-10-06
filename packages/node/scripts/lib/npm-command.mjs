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
  return exec(process.execPath, [cli, ...args], { cwd, env: options.env ?? isolatedProcessEnvironment(),
    timeout: options.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 });
}

export function isolatedProcessEnvironment(home) {
  // Allowlist, not a blacklist: no tokens, cloud credentials, proxy credentials,
  // NODE_OPTIONS, NODE_PATH, npm hooks, SSH variables or Docker remote settings.
  const environment = { npm_config_ignore_scripts: 'true', npm_config_global: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  if (home !== undefined) {
    environment.HOME = home;
    environment.USERPROFILE = home;
    // Keep npm's transient files inside the disposable verification home.
    // Callers supplying a home must create this directory first.
    environment.TMPDIR = resolve(home, 'npm-tmp');
    environment.TMP = environment.TMPDIR;
    environment.TEMP = environment.TMPDIR;
    environment.npm_config_userconfig = resolve(home, 'user.npmrc');
    environment.npm_config_globalconfig = resolve(home, 'global.npmrc');
    environment.npm_config_cache = resolve(home, 'npm-cache');
  }
  return environment;
}
