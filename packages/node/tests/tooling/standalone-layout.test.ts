import { describe, expect, it } from 'vitest';
const { isStandalonePath, assertExportEntry, filterStandaloneAllowlist } = await import(
  new URL('../../scripts/lib/standalone-layout.mjs', import.meta.url).href
) as {
  isStandalonePath(path: string): boolean;
  assertExportEntry(path: string, mode: string): void;
  filterStandaloneAllowlist(document: unknown): { literals: unknown[] };
};

describe('Standalone source boundary', () => {
  it('includes protocol and required shared checks, not embedding applications', () => {
    expect(isStandalonePath('packages/node/src/index.ts')).toBe(true);
    expect(isStandalonePath('protocol/schemas/schema.json')).toBe(true);
    expect(isStandalonePath('scripts/production-source-size.mjs')).toBe(true);
    expect(isStandalonePath('Known-Backend/package.json')).toBe(false);
    expect(isStandalonePath('Demos/core-demo/data/keys/key.bin')).toBe(false);
    expect(isStandalonePath('packages/node/../Known-Backend/package.json')).toBe(false);
  });
  it('rejects links, build products and environment files', () => {
    expect(() => assertExportEntry('packages/node/link', '120000')).toThrow();
    expect(() => assertExportEntry('packages/node/dist/index.js', '100644')).toThrow();
    expect(() => assertExportEntry('packages/node/.env.local', '100644')).toThrow();
    expect(() => assertExportEntry('packages/node/src/index.ts', '100644')).not.toThrow();
  });
  it('retains only the applicable literal exceptions without broadening their paths', () => {
    expect(filterStandaloneAllowlist({ literals: [
      { paths: ['packages/node/tests/fixture.ts', 'Known-Backend/tests/fixture.ts'], literal: 'dummy', reason: 'fixture' },
      { path: 'Known-Backend/config.ts', literal: 'other', reason: 'unrelated' },
    ] })).toEqual({ literals: [{ paths: ['packages/node/tests/fixture.ts'], literal: 'dummy', reason: 'fixture' }] });
  });
});
