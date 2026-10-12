import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The browser harness imports COLP Server from ../server. Know-N runs the same harness,
// including its Know-N-only product specs, against a Known-Backend checkout.
const [root, separator, command, ...args] = process.argv.slice(2);
if (!root || separator !== '--' || !command) throw new Error('Usage: with-know-n-backend.mjs <Known-Backend> -- <command> [args]');
const backend = await realpath(root);
await access(resolve(backend, 'src/bootstrap/sync-session-runtime.ts'));
const loader = pathToFileURL(resolve(import.meta.dirname, 'know-n-backend-loader.mjs')).href;
const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env,
  KNOWN_E2E_BACKEND_ROOT: backend, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${loader}` } });
child.on('error', error => { throw error; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
});
