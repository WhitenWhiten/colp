import { defineConfig } from 'tsup';

const entry = {
  index: 'src/index.ts',
  'schema/index': 'src/schema/index.ts',
  'types/index': 'src/types/index.ts',
  'semantic/index': 'src/semantic/index.ts',
  'client/index': 'src/client/index.ts',
  'server/index': 'src/server/index.ts',
  'publisher/index': 'src/publisher/index.ts',
  'adapters/index': 'src/adapters/index.ts',
  'feed/index': 'src/feed/index.ts',
  'sync/index': 'src/sync/index.ts',
  'sync/unsafe': 'src/sync/unsafe.ts',
  'sync/canonical': 'src/sync/canonical.ts',
  'sync/browser': 'src/sync/browser.ts',
  'testing/index': 'src/testing/index.ts',
  'delivery/index': 'src/delivery/index.ts',
  'conformance/index': 'src/conformance/index.ts',
  'security/index': 'src/security/index.ts',
  'mcp/index': 'src/mcp/index.ts',
  'mcp/2026-07-28/index': 'src/mcp/2026-07-28/index.ts',
};

export default defineConfig({
  entry,
  clean: true,
  // canonicalize 3.x publishes only an ESM `import` export condition (no CJS
  // `require`), so the packed CJS bundles would fail to load it at runtime.
  // It is a small pure-JS dependency; inline it so every entry (including the
  // /mcp Write adapter graph pulled in by COLP-MCP-13) stays CJS-loadable.
  // url-template and @noble/hashes are inlined so ./sync/canonical and
  // ./sync/browser stay portable for MV3 bundlers without Node builtins.
  noExternal: ['canonicalize', 'url-template', '@noble/hashes'],
  // Build unsafe and testing declarations separately: sharing this declaration
  // graph lets Rollup hoist their private members into ./sync as synthetic
  // a/b/c exports.
  dts: {
    entry: Object.fromEntries(Object.entries(entry).filter(
      ([name]) => name !== 'sync/unsafe' && name !== 'testing/index',
    )),
  },
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  platform: 'node',
  // Source maps reveal the complete authored source and dominate the packed
  // artifact size. Keep them out of the production package; developers and
  // CI execute directly from TypeScript sources.
  sourcemap: false,
  // Keep shared runtime state (error constructors, validator registries, and
  // schemas) in one ESM chunk instead of cloning it into every public entry.
  // This is also materially smaller for consumers that import multiple
  // subpaths in the same process.
  splitting: true,
  target: 'node22',
  treeshake: true,
});
