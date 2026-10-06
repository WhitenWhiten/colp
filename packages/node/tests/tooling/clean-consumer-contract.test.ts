import { describe, expect, it } from 'vitest';

const { runtimeSpecifiers } = await import(new URL('../../scripts/clean-tarball-consumer.mjs', import.meta.url).href) as {
  runtimeSpecifiers(manifest: unknown): string[];
};

describe('Clean tarball consumer selection', () => {
  it('checks runtime subpaths but loads a raw JSON asset separately', () => {
    expect(runtimeSpecifiers({ name: '@collection-protocol/node', exports: {
      '.': { import: './dist/index.js', require: './dist/index.cjs' },
      './server': { import: './dist/server/index.js', require: './dist/server/index.cjs' },
      './schema/collection-protocol.schema.json': './dist/schema/schema.json',
    } })).toEqual(['@collection-protocol/node', '@collection-protocol/node/server']);
  });
  it('rejects missing package export metadata', () => {
    expect(() => runtimeSpecifiers({ name: '@collection-protocol/node' })).toThrow();
  });
});
