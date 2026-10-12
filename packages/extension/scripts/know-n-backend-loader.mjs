import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Redirects the harness's ../server imports to the Know-N backend named by with-know-n-backend.mjs.
const server = resolve(import.meta.dirname, '../../server');
const backend = process.env.KNOWN_E2E_BACKEND_ROOT;
if (!backend) throw new Error('KNOWN_E2E_BACKEND_ROOT is required');
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith('file:')) target = new URL(specifier);
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = new URL(specifier, context.parentURL);
    else if (specifier.startsWith('/')) target = pathToFileURL(specifier);
    if (target?.protocol === 'file:') {
      const path = fileURLToPath(target);
      if (path.startsWith(`${server}/`)) {
        return nextResolve(pathToFileURL(resolve(backend, path.slice(server.length + 1))).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
