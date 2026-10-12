#!/usr/bin/env node
import { spawn } from 'node:child_process';

const rest = process.argv.slice(2);
if (rest.length === 0) {
  process.stderr.write('usage: with-xvfb.mjs <command> [...args]\n');
  process.exit(2);
}

const watch = process.env.KNOWN_E2E_HEADED === '1';
const useXvfb = process.platform === 'linux' && !watch;
const command = useXvfb ? 'xvfb-run' : rest[0];
const args = useXvfb
  ? ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', ...rest]
  : rest.slice(1);

const child = spawn(command, args, { stdio: 'inherit' });
child.on('error', (error) => {
  if (useXvfb && error && 'code' in error && error.code === 'ENOENT') {
    process.stderr.write('xvfb-run is required for extension e2e (permission bubbles need a virtual display).\n');
  }
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
