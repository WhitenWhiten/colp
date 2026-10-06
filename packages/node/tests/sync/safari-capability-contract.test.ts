import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  assertPublicHttpManifest,
  assertSafariReplicaCapability,
  declareSafariReplicaCapability,
} from '../../src/sync/replica-capability.js';

const evidence = '[evidence:sync.safari-capability]';
const fixturesPath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve(fixturesPath, name), 'utf8')) as Record<string, any>;
}

describe(`SYNC-0021 Safari capability declaration and Manifest separation ${evidence}`, () => {
  const registry = createValidatorRegistry();

  it(`declares the Safari Adapter on the Sync Session Replica ${evidence}`, async () => {
    const request = await fixture('sync-session-request.json');
    request.replica = {
      ...request.replica,
      ...declareSafariReplicaCapability('1.0.0', request.replica.capabilities),
    };
    assertSafariReplicaCapability(request.replica);

    expect(registry.validate('syncSessionRequest', request).valid).toBe(true);
    expect(request.replica.adapter.profile).toBe('safari-bookmarks-v1');
  });

  it(`keeps server profiles in the public Manifest without local adapter state ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].profiles = ['core', 'sync'];

    expect(() => assertPublicHttpManifest(manifest as any)).not.toThrow();
    expect(registry.validate('manifest', manifest).valid).toBe(true);
    expect(manifest.mounts[0]).not.toHaveProperty('adapter');
    expect(manifest).not.toHaveProperty('replica');
  });

  it(`rejects Safari state embedded in the public Manifest ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].adapter = { profile: 'safari-bookmarks-v1', version: '1.0.0' };

    expect(() => assertPublicHttpManifest(manifest as any)).toThrow();
    expect(registry.validate('manifest', manifest).valid).toBe(false);
  });

  it(`rejects a Safari flag in capabilities instead of the adapter declaration ${evidence}`, async () => {
    const request = await fixture('sync-session-request.json');
    request.replica.adapter = { profile: 'chromium-bookmarks-v1', version: '1.0.0' };
    request.replica.capabilities.safariAdapter = true;

    expect(() => assertSafariReplicaCapability(request.replica)).toThrow();
    expect(registry.validate('syncSessionRequest', request).valid).toBe(false);
  });

  it(`rejects empty or missing adapter profiles at the declaration boundary ${evidence}`, async () => {
    const emptyProfile = await fixture('sync-session-request.json');
    emptyProfile.replica.adapter = { profile: '', version: '1.0.0' };
    expect(registry.validate('syncSessionRequest', emptyProfile).valid).toBe(false);

    const missingProfile = await fixture('sync-session-request.json');
    missingProfile.replica.adapter = { version: '1.0.0' };
    expect(registry.validate('syncSessionRequest', missingProfile).valid).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['non-string', 1 as unknown as string],
    ['null', null as unknown as string],
  ] as const)(`rejects Safari adapter declaration with %s version ${evidence}`, (_label, version) => {
    expect(() => declareSafariReplicaCapability(version, { sync: true } as never)).toThrow(TypeError);
    expect(() => declareSafariReplicaCapability(version, { sync: true } as never)).toThrow(/version/u);
  });

  it(`rejects Safari replica assertion when adapter version is empty ${evidence}`, async () => {
    const request = await fixture('sync-session-request.json');
    request.replica.adapter = { profile: 'safari-bookmarks-v1', version: '' };
    expect(() => assertSafariReplicaCapability(request.replica)).toThrow(TypeError);
    expect(() => assertSafariReplicaCapability(request.replica)).toThrow(/version/u);
  });

  it(`rejects a non-Safari adapter profile on the Safari capability boundary ${evidence}`, async () => {
    const request = await fixture('sync-session-request.json');
    request.replica.adapter = { profile: 'firefox-bookmarks-v1', version: '1.0.0' };
    expect(() => assertSafariReplicaCapability(request.replica)).toThrow(TypeError);
    expect(() => assertSafariReplicaCapability(request.replica)).toThrow(/Safari adapter profile/u);
  });

  it(`rejects nested local adapter state buried under Manifest extensions ${evidence}`, async () => {
    const manifest = await fixture('public-manifest.json');
    manifest.mounts[0].extensions = {
      local: {
        nested: {
          adapter: { profile: 'safari-bookmarks-v1', version: '1.0.0' },
        },
      },
    };

    expect(() => assertPublicHttpManifest(manifest as any)).toThrow(TypeError);
    expect(() => assertPublicHttpManifest(manifest as any)).toThrow(/local adapter state/u);
  });

  it(`rejects adapterProfile / adapterVersion aliases nested in Manifest objects ${evidence}`, async () => {
    const byProfile = await fixture('public-manifest.json');
    byProfile.extensions = { adapterProfile: 'safari-bookmarks-v1' };
    expect(() => assertPublicHttpManifest(byProfile as any)).toThrow(/local adapter state/u);

    const byVersion = await fixture('public-manifest.json');
    byVersion.mounts[0].meta = { adapterVersion: '1.0.0' };
    expect(() => assertPublicHttpManifest(byVersion as any)).toThrow(/local adapter state/u);
  });
});
