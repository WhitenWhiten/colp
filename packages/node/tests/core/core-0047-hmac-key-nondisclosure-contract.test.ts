import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { inspect } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const cryptoProbe = vi.hoisted(() => ({ keys: [] as Uint8Array[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHmac(algorithm: string, key: import('node:crypto').BinaryLike) {
      if (key instanceof Uint8Array) cryptoProbe.keys.push(key);
      return actual.createHmac(algorithm, key);
    },
  };
});

import * as adapterApi from '../../src/adapters/index.js';
import * as clientApi from '../../src/client/index.js';
import * as rootApi from '../../src/index.js';
import * as serverApi from '../../src/server/index.js';

const evidence = '[evidence:core.hmac-key-nondisclosure]';
const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, '../..');
const wirePattern = /^prf\.h1\.([A-Za-z0-9._~-]{1,77})\.([A-Za-z0-9_-]{43})$/u;
const publicVersion = 'rotation-public-2026-07';
const secretText = 'CORE0047_SERVER_HMAC_KEY_DO_NOT_DISCLOSE!';
const secretKey = Uint8Array.from(Buffer.from(secretText, 'ascii'));

interface HandleOptions {
  readonly key: serverApi.ProfileIdHmacKey;
  readonly keyVersion: string;
  readonly serverScope: string;
  readonly tenantScope: string;
}

function handleOptions(
  key: serverApi.ProfileIdHmacKey = serverApi.createProfileIdHmacKey(secretKey),
  overrides: Partial<Omit<HandleOptions, 'key'>> = {},
): HandleOptions {
  return {
    key,
    keyVersion: publicVersion,
    serverScope: 'server.example.test',
    tenantScope: 'tenant_47',
    ...overrides,
  };
}

function secretForms(bytes: Uint8Array = secretKey): readonly string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString('utf8'),
    buffer.toString('hex'),
    buffer.toString('hex').toUpperCase(),
    buffer.toString('base64'),
    buffer.toString('base64url'),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function representations(value: unknown): readonly string[] {
  const values = [inspect(value, { depth: 8, getters: false })];
  try {
    values.push(String(value));
  } catch {
    values.push('[unstringifiable]');
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) values.push(json);
  } catch {
    values.push('[unserializable]');
  }
  if (value instanceof Error) values.push(value.message, value.stack ?? '');
  return values;
}

function expectNoKeyMaterial(value: unknown, bytes: Uint8Array = secretKey): void {
  for (const rendered of representations(value)) {
    for (const forbidden of secretForms(bytes)) expect(rendered).not.toContain(forbidden);
  }
}

function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

function spyOnConsole(): readonly ReturnType<typeof vi.spyOn>[] {
  return (['debug', 'info', 'log', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

function expectSilent(spies: readonly ReturnType<typeof vi.spyOn>[]): void {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
}

function jsonFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(path) : entry.name.endsWith('.json') ? [path] : [];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  cryptoProbe.keys.length = 0;
});

describe(`CORE-0047 server HMAC key nondisclosure ${evidence}`, () => {
  it('returns only a public-versioned digest and preserves the caller key buffer', () => {
    const callerKey = secretKey.slice();
    const before = callerKey.slice();
    const key = serverApi.createProfileIdHmacKey(callerKey);
    const result = serverApi.createHmacProfileId('local-profile-47', {
      key,
      keyVersion: publicVersion,
      serverScope: 'server.example.test',
      tenantScope: 'tenant_47',
    });

    expect(result).toMatch(wirePattern);
    expect(wirePattern.exec(result)?.[1]).toBe(publicVersion);
    expect(callerKey).toEqual(before);
    expectNoKeyMaterial(result, callerKey);
    expectNoKeyMaterial(key, callerKey);
    expect(Object.keys(key)).toEqual([]);
    expect(JSON.stringify(key)).toBe('{}');
    expectNoKeyMaterial(JSON.stringify({ profileId: result, keyVersion: publicVersion }), callerKey);

    key.destroy();
    expect(key.destroyed).toBe(true);
    key.destroy();
    const destroyedError = captureThrown(() =>
      serverApi.createHmacProfileId('local-profile-47', handleOptions(key)),
    );
    expectNoKeyMaterial(destroyedError, callerKey);
  });

  it('uses a public version for controlled lookup without returning the provider key', () => {
    const requested: string[] = [];
    const callerKey = secretKey.slice();
    const before = callerKey.slice();
    const keys = new Map([[publicVersion, serverApi.createProfileIdHmacKey(callerKey)]]);
    const lookup = (version: string): serverApi.ProfileIdHmacKey => {
      requested.push(version);
      const selected = keys.get(version);
      if (selected === undefined) throw new Error('Unknown public key version.');
      return selected;
    };
    const result = serverApi.createHmacProfileId('local-profile-47', handleOptions(lookup(publicVersion)));

    expect(requested).toEqual([publicVersion]);
    expect(wirePattern.exec(result)?.[1]).toBe(publicVersion);
    expect(callerKey).toEqual(before);
    expectNoKeyMaterial(result, callerKey);
  });

  it('selects rotation keys by public labels and never echoes either key', () => {
    const oldKey = Uint8Array.from(Buffer.from('CORE0047_OLD_ROTATION_KEY!'.repeat(2), 'ascii'));
    const nextKey = Uint8Array.from(Buffer.from('CORE0047_NEXT_ROTATION_KEY'.repeat(2), 'ascii'));
    const keys = new Map<string, serverApi.ProfileIdHmacKey>([
      ['old-v1', serverApi.createProfileIdHmacKey(oldKey)],
      ['next-v2', serverApi.createProfileIdHmacKey(nextKey)],
    ]);
    const requested: string[] = [];
    const lookup = (version: string) => {
      requested.push(version);
      const selected = keys.get(version);
      if (selected === undefined) throw new Error('Unknown public key version.');
      return selected;
    };

    const oldResult = serverApi.createHmacProfileId('same-local', handleOptions(lookup('old-v1'), { keyVersion: 'old-v1' }));
    const nextResult = serverApi.createHmacProfileId('same-local', handleOptions(lookup('next-v2'), { keyVersion: 'next-v2' }));

    expect(requested).toEqual(['old-v1', 'next-v2']);
    expect(oldResult).not.toBe(nextResult);
    expect(wirePattern.exec(oldResult)?.[1]).toBe('old-v1');
    expect(wirePattern.exec(nextResult)?.[1]).toBe('next-v2');
    for (const result of [oldResult, nextResult]) {
      expectNoKeyMaterial(result, oldKey);
      expectNoKeyMaterial(result, nextKey);
    }
  });

  it('clears the package-owned key copy passed to crypto after successful derivation', () => {
    const callerKey = secretKey.slice();
    const key = serverApi.createProfileIdHmacKey(callerKey);
    serverApi.createHmacProfileId('local-profile-47', handleOptions(key));

    expect(cryptoProbe.keys).toHaveLength(1);
    expect(cryptoProbe.keys[0]).not.toBe(callerKey);
    expect(Array.from(cryptoProbe.keys[0]!)).toEqual(Array(callerKey.byteLength).fill(0));
    expect(callerKey).toEqual(secretKey);
  });

  it.each([
    ['invalid local string', `local\u0000${secretText}`, secretKey],
    ['invalid local bytes', new Uint8Array(), secretKey],
    ['missing local ID', undefined, secretKey],
    ['string key', 'local-profile-47', secretText],
    ['short key', 'local-profile-47', secretKey.slice(0, 31)],
    ['long key', 'local-profile-47', new Uint8Array(1025).fill(0x47)],
    ['invalid public version', 'local-profile-47', secretKey],
  ])('keeps low-level server errors and logs free of key bytes: %s', (label, localId, callerKey) => {
    const spies = spyOnConsole();
    const error = captureThrown(() =>
      serverApi.createHmacProfileId(localId as string | Uint8Array, {
        key: label === 'string key' || label === 'short key' || label === 'long key'
          ? callerKey as unknown as serverApi.ProfileIdHmacKey
          : serverApi.createProfileIdHmacKey(secretKey),
        keyVersion: label === 'invalid public version' ? `bad/${secretText}` : publicVersion,
        serverScope: 'server.example.test',
        tenantScope: 'tenant_47',
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expectNoKeyMaterial(error, secretKey);
    expectSilent(spies);
  });

  it.each([
    ['empty string local ID', ''],
    ['control-bearing local ID', `local\u0000${secretText}`],
    ['malformed UTF-16 local ID', `local\ud800${secretText}`],
    ['empty byte local ID', new Uint8Array()],
    ['oversized byte local ID', new Uint8Array(4097)],
    ['ordinary array local ID', Array.from(secretKey)],
    ['null local ID', null],
    ['missing local ID', undefined],
  ])('rejects %s without key material in the error or console', (_label, localId) => {
    const spies = spyOnConsole();
    const error = captureThrown(() =>
      serverApi.createHmacProfileId(localId as unknown as string | Uint8Array, handleOptions()),
    );

    expect(error).toBeInstanceOf(Error);
    expectNoKeyMaterial(error);
    expectSilent(spies);
  });

  it.each([
    ['null options', null],
    ['missing options', undefined],
    ['primitive options', secretText],
    ['empty keyVersion', handleOptions(undefined, { keyVersion: '' })],
    ['invalid keyVersion', handleOptions(undefined, { keyVersion: `bad/${secretText}` })],
    ['oversized keyVersion', handleOptions(undefined, { keyVersion: secretText.repeat(3) })],
    ['empty server scope', handleOptions(undefined, { serverScope: '' })],
    ['invalid server scope', handleOptions(undefined, { serverScope: `bad scope ${secretText}` })],
    ['empty tenant scope', handleOptions(undefined, { tenantScope: '' })],
    ['invalid tenant scope', handleOptions(undefined, { tenantScope: `bad scope ${secretText}` })],
    ['missing handle', { ...handleOptions(), key: undefined }],
    ['forged handle', { ...handleOptions(), key: Object.freeze({ destroyed: false, destroy() {} }) }],
  ])('rejects %s without embedding options or key-like input', (_label, invalidOptions) => {
    const spies = spyOnConsole();
    const error = captureThrown(() =>
      serverApi.createHmacProfileId('local-profile-47', invalidOptions as unknown as HandleOptions),
    );

    expect(error).toBeInstanceOf(Error);
    expectNoKeyMaterial(error);
    expectSilent(spies);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', secretText],
    ['ordinary array', Array.from(secretKey)],
    ['31 bytes', secretKey.slice(0, 31)],
    ['1025 bytes', new Uint8Array(1025).fill(0x47)],
    ['Promise', Promise.resolve(secretKey)],
  ])('rejects invalid key import without echoing material: %s', (_label, provided) => {
    const spies = spyOnConsole();
    const error = captureThrown(() =>
      serverApi.createProfileIdHmacKey(provided as unknown as Uint8Array),
    );

    expect(error).toBeInstanceOf(Error);
    expectNoKeyMaterial(error);
    expectNoKeyMaterial({ error, publicVersion });
    expectSilent(spies);
  });

  it.each([
    ['plain object', {}],
    ['matching shape', { destroyed: false, destroy() {} }],
    ['frozen matching shape', Object.freeze({ destroyed: false, destroy() {} })],
    ['proxy', new Proxy({}, {})],
    ['function', () => undefined],
    ['symbol', Symbol(secretText)],
    ['destroyed handle', (() => { const value = serverApi.createProfileIdHmacKey(secretKey); value.destroy(); return value; })()],
    ['independently frozen handle-like object', Object.freeze(Object.create(null))],
  ] as const)('rejects forged or destroyed handles without reflecting them: %s', (_label, key) => {
    const spies = spyOnConsole();
    const error = captureThrown(() =>
      serverApi.createHmacProfileId('local-profile-47', {
        ...handleOptions(),
        key: key as unknown as serverApi.ProfileIdHmacKey,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('cause');
    expectNoKeyMaterial(error);
    expectNoKeyMaterial({ status: 'failed', error, options: { keyVersion: publicVersion } });
    expectSilent(spies);
  });

  it.each(['keyVersion', 'serverScope', 'tenantScope', 'key'] as const)(
    'sanitizes a throwing %s accessor without inspecting the thrown value',
    (field) => {
      const malicious = new Error(Buffer.from(secretKey).toString('base64url'));
      const options = handleOptions();
      Object.defineProperty(options, field, { enumerable: true, get: () => { throw malicious; } });
      const spies = spyOnConsole();
      const error = captureThrown(() => serverApi.createHmacProfileId('local-profile-47', options));

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBe(malicious);
      expectNoKeyMaterial(error);
      expectSilent(spies);
    },
  );

  it('does not log on success through console debug, info, log, warn, or error', () => {
    const spies = spyOnConsole();
    const result = serverApi.createHmacProfileId('local-profile-47', handleOptions());

    expect(result).toMatch(wirePattern);
    expectSilent(spies);
  });

  it('does not attach key material to package-owned returned or thrown objects', () => {
    const key = serverApi.createProfileIdHmacKey(secretKey);
    const result = serverApi.createHmacProfileId('local-profile-47', handleOptions(key));
    const failure = captureThrown(() =>
      serverApi.createHmacProfileId('local-profile-47', handleOptions(Object.freeze({
        destroyed: false,
        destroy() { throw new Error(secretText); },
      }) as serverApi.ProfileIdHmacKey)),
    );
    const maliciousBytes = new Proxy(secretKey, {
      get() { throw new Error(secretText); },
    });
    const importFailure = captureThrown(() => serverApi.createProfileIdHmacKey(maliciousBytes));
    const localFailure = captureThrown(() =>
      serverApi.createHmacProfileId(maliciousBytes, handleOptions(key)),
    );

    expect(typeof result).toBe('string');
    expectNoKeyMaterial(result);
    expectNoKeyMaterial(Object(result));
    expectNoKeyMaterial(failure);
    expectNoKeyMaterial(importFailure);
    expectNoKeyMaterial(localFailure);
    expectNoKeyMaterial({ result, failure, importFailure, localFailure });
  });

  it('keeps derivation off client/adapters and key-provider lookup on the server surface', () => {
    for (const api of [clientApi, adapterApi]) {
      expect(api).not.toHaveProperty('createHmacProfileId');
      expect(api).not.toHaveProperty('createProfileIdHmacKey');
      expect(api).not.toHaveProperty('HmacProfileIdOptions');
      expect(api).not.toHaveProperty('HmacProfileIdKeyProvider');
      expect(api).not.toHaveProperty('HmacProfileIdKeyProviderOptions');
      expectNoKeyMaterial(api);
    }
    expect(rootApi).not.toHaveProperty('createHmacProfileId');
    expect(rootApi).not.toHaveProperty('createProfileIdHmacKey');
    expect(serverApi).toHaveProperty('createHmacProfileId');
    expect(serverApi).toHaveProperty('createProfileIdHmacKey');
  });

  it('keeps source barrels and package subpath exports server-only', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const rootSource = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8');
    const clientSource = readFileSync(resolve(packageRoot, 'src/client/index.ts'), 'utf8');
    const adapterSource = readFileSync(resolve(packageRoot, 'src/adapters/index.ts'), 'utf8');
    const serverSource = readFileSync(resolve(packageRoot, 'src/server/index.ts'), 'utf8');

    for (const source of [clientSource, adapterSource]) {
      expect(source).not.toMatch(/createHmacProfileId|HmacProfileId(?:KeyProvider|Options)/u);
      expectNoKeyMaterial(source);
    }
    expect(rootSource).not.toMatch(/createHmacProfileId|createProfileIdHmacKey|HmacProfileIdOptions/u);
    expect(serverSource).toContain('createHmacProfileId');
    expect(serverSource).toContain('createProfileIdHmacKey');
    expect(packageJson.exports).toHaveProperty('./server');
    expect(packageJson.exports).toHaveProperty('./client');
    expect(JSON.stringify(packageJson.exports['./client'])).not.toMatch(/profile-id|hmac|key-provider/iu);
  });

  it('keeps built client declarations key-free and provider declarations server-only when present', () => {
    const clientForbidden = /createHmacProfileId|HmacProfileId(?:KeyProvider|Options)/u;
    const providerForbidden = /createHmacProfileId|createProfileIdHmacKey|HmacProfileIdOptions|ProfileIdHmacKey/u;
    const rootDeclarations = ['dist/index.d.ts', 'dist/index.d.cts'];
    const clientDeclarations = ['dist/client/index.d.ts', 'dist/client/index.d.cts'];
    const serverDeclarations = ['dist/server/index.d.ts', 'dist/server/index.d.cts'];

    for (const relativePath of clientDeclarations) {
      const path = resolve(packageRoot, relativePath);
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toMatch(clientForbidden);
    }
    for (const relativePath of rootDeclarations) {
      const path = resolve(packageRoot, relativePath);
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toMatch(providerForbidden);
    }
    for (const relativePath of serverDeclarations) {
      const path = resolve(packageRoot, relativePath);
      if (existsSync(path)) {
        const declaration = readFileSync(path, 'utf8');
        expect(declaration).toContain('createProfileIdHmacKey');
        expect(declaration).toContain('ProfileIdHmacKey');
        expect(declaration).not.toContain(secretText);
      }
    }
  });

  it('keeps wire schemas and canonical JSON examples free of HMAC server-key fields and bytes', () => {
    const files = [
      resolve(packageRoot, 'src/schema/generated/collection-protocol.schema.json'),
      ...jsonFiles(resolve(packageRoot, 'fixtures/protocol/examples')),
    ];

    expect(files.length).toBeGreaterThan(1);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      expect(text).not.toMatch(/"(?:hmacKey|serverHmacKey|keyMaterial)"\s*:/iu);
      expectNoKeyMaterial(text);
      expectNoKeyMaterial(parsed);
    }
  });

  it('allows the public version label in JSON results without serializing provider state', () => {
    const profileId = serverApi.createHmacProfileId('local-profile-47', handleOptions());
    const wireResult = JSON.stringify({ profileId, keyVersion: publicVersion });

    expect(wireResult).toContain(publicVersion);
    expect(wireResult).not.toMatch(/keyProvider|hmacKey|keyMaterial/iu);
    expectNoKeyMaterial(wireResult);
  });
});
