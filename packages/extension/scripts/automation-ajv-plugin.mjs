import { resolve, sep } from 'node:path';

/* The @know-n/colp automation core compiles its schemas with Ajv at runtime,
   which MV3's CSP forbids. Inside that core only, resolve Ajv and ajv-formats
   to shims backed by validators generated at build time
   (scripts/generate-automation-validators.mjs). Every other Ajv import is
   left alone. */
export function automationAjvPlugin(root) {
  const core = `${sep}@know-n${sep}colp${sep}dist${sep}automation${sep}`;
  const shims = {
    'ajv/dist/2020.js': resolve(root, 'src/automation/ajv-standalone.ts'),
    'ajv-formats': resolve(root, 'src/automation/ajv-formats-standalone.ts'),
  };
  return {
    name: 'automation-ajv-standalone',
    setup(build) {
      build.onResolve({ filter: /^(?:ajv\/dist\/2020\.js|ajv-formats)$/ }, (args) =>
        args.importer.includes(core) ? { path: shims[args.path] } : undefined);
    },
  };
}
