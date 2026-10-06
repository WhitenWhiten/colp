import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageStatus, protocolVersion, supportedProfiles } from '../../src/index.js';
import * as rootApi from '../../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const userVisibleClaimDocs = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/PUBLICATION_QUICKSTART.md',
] as const;
const verifiedProfiles = [
  'core',
  'publication',
  'publisher',
  'feed',
  'sync',
  'mcp-read',
  'mcp-write',
] as const;

describe('package conformance claims', () => {
  it('keeps the package root metadata-only', () => {
    expect(Object.keys(rootApi).sort()).toEqual([
      'packageStatus',
      'protocolVersion',
      'supportedProfiles',
    ]);
  });

  it('publishes only the verified profile set', () => {
    expect(packageStatus).toBe('development');
    expect(protocolVersion).toBe('0.1');
    expect(supportedProfiles).toEqual([...verifiedProfiles]);
  });

  it('restores mcp-read and mcp-write after COLP-MCP-15 accepted 2026-07-28 evidence', () => {
    expect(supportedProfiles).toContain('mcp-read');
    expect(supportedProfiles).toContain('mcp-write');
  });

  it('freezes supportedProfiles so the verified set cannot grow at runtime', () => {
    expect(Object.isFrozen(supportedProfiles)).toBe(true);
    expect(supportedProfiles).toHaveLength(7);
    const mutable = supportedProfiles as unknown as string[];
    expect(() => mutable.push('future')).toThrow(TypeError);
    expect(supportedProfiles).toHaveLength(7);
    expect(supportedProfiles).toEqual([...verifiedProfiles]);
  });

  it('keeps user-visible docs aligned with the verified mcp-read and mcp-write claims', () => {
    for (const relative of userVisibleClaimDocs) {
      const source = readFileSync(resolve(packageRoot, relative), 'utf8');
      expect(source, relative).toContain('mcp-read');
      expect(source, relative).toContain('mcp-write');
      expect(source, relative).not.toContain('quarantined while the SDK migrates');
    }
  });

  it('publishes ./sync as a first-class subpath without a dedicated legacy export', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(packageJson.exports['./sync']).toEqual({
      types: {
        import: './dist/sync/index.d.ts',
        require: './dist/sync/index.d.cts',
      },
      import: './dist/sync/index.js',
      require: './dist/sync/index.cjs',
    });
    expect(Object.hasOwn(packageJson.exports, './sync/legacy')).toBe(false);
    expect(Object.hasOwn(packageJson.exports, './legacy')).toBe(false);

    const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/public subpaths are[\s\S]*`sync`/u);
  });
});
