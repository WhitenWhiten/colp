import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { preserveBookmarkUrl } from '../../src/schema/index.js';
import { createUrlHash, urlHashMatches } from '../../src/semantic/index.js';
import {
  createValidatorRegistry,
  preserveBookmarkUrl as preserveBookmarkUrlFromSchema,
  validateWireDocument,
  type DefinitionName,
} from '../../src/schema/index.js';
import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:core.sensitive-url-preservation]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

type JsonRecord = Record<string, any>;

function fixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonRecord;
}

function bookmarkNode(url: string): JsonRecord {
  const snapshot = fixture('collection-snapshot.json');
  return { ...snapshot.nodes[1], url };
}

function bookmarkCreate(url: string): JsonRecord {
  return { kind: 'bookmark', title: 'Sensitive URL', url };
}

function expectUrlError(definition: DefinitionName, value: unknown): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ instancePath: '/url' })]),
  );
}

function exactSha256(url: string): string {
  return `sha-256=:${createHash('sha256').update(url, 'utf8').digest('base64')}:`;
}

describe(`CORE-0021 caller-declared sensitive URL preservation ${evidence}`, () => {
  it.each([
    'HTTPS://EXAMPLE.COM:443/Download?X-Amz-Signature=Aa%2fb%2B&part=&part=2#Receipt',
    'https://example.test/caf%C3%A9?label=%E7%9F%A5%E8%AF%86',
    'https://example.test/cafe%CC%81?label=%E7%9F%A5%E8%AF%86',
  ])('returns the same caller string from both public preservation exports: %s', (url) => {
    expect(preserveBookmarkUrl(url)).toBe(url);
    expect(preserveBookmarkUrlFromSchema(url)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'VBScript:msgbox(1)',
    'data:text/plain,bookmark',
    '/relative/bookmark',
    'https://example.test/has space',
  ])('rejects unsafe input at both public preservation exports: %j', (url) => {
    expect(() => preserveBookmarkUrl(url)).toThrow(TypeError);
    expect(() => preserveBookmarkUrlFromSchema(url)).toThrow(TypeError);
  });

  it('keeps distinct percent-encoded Unicode spellings distinct', () => {
    const composed = 'https://example.test/caf%C3%A9?label=%E7%9F%A5%E8%AF%86';
    const decomposed = 'https://example.test/cafe%CC%81?label=%E7%9F%A5%E8%AF%86';

    expect(preserveBookmarkUrl(composed)).toBe(composed);
    expect(preserveBookmarkUrl(decomposed)).toBe(decomposed);
    expect(createUrlHash(composed)).not.toBe(createUrlHash(decomposed));
  });

  it.each([
    ['signed query and exact case', 'HTTPS://EXAMPLE.COM:443/Download?X-Amz-Signature=Aa%2fb%2B&X-Amz-Date=20260717T010203Z#Receipt'],
    ['temporary token', 'https://example.test/access?temporary=AbC.012_-&expires=0000123#grant'],
    ['order-sensitive query', 'https://example.test/run?step=third&step=first&step=second'],
    ['duplicate and empty parameters', 'https://example.test/run?key=one&key=&key=two&&flag&trailing='],
    ['percent-encoding spelling', 'https://example.test/%7euser/%2fkeep?encoded=%2b%2F%41'],
    ['explicit default port', 'http://EXAMPLE.TEST:80/path?value=1#kept'],
    ['fragment spelling', 'https://example.test/path?value=1#Case-Sensitive%2fFragment'],
    ['percent-encoded Unicode', 'https://example.test/%E7%94%A8%E6%88%B7?name=%E7%9F%A5%E8%AF%86'],
  ])('retains the exact %s string through Bookmark creation validation', (_case, url) => {
    const input = bookmarkCreate(url);
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      input,
      () => ({ valid: true, issues: [] }),
    );

    expect(result).toEqual({ valid: true, value: input });
    if (!result.valid) return;
    expect(result.value).toBe(input);
    expect(result.value.url).toBe(url);
  });

  it.each([
    ['node', (url: string) => bookmarkNode(url)],
    ['nodeCreate', (url: string) => bookmarkCreate(url)],
    ['nodeMergePatch', (url: string) => ({ url })],
  ] as const)('does not parse or reconstruct the URL on the %s public wire carrier', (definition, build) => {
    const url = 'HTTPS://EXAMPLE.TEST:443/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep';
    const input = build(url);
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      definition,
      input,
      () => ({ valid: true, issues: [] }),
    );

    expect(result).toEqual({ valid: true, value: input });
    if (!result.valid) return;
    expect(result.value).toBe(input);
    expect(result.value.url).toBe(url);
  });

  it.each([
    ['signature', 'sig'],
    ['temporary-token', 'temporary_token'],
    ['ordinary-looking', 'page'],
    ['unknown extension', 'x-vendor-opaque'],
  ])('does not infer preservation from a %s parameter name', (_case, parameterName) => {
    const url = `https://example.test/item?${parameterName}=B&${parameterName}=A&${parameterName}=`;
    const input = bookmarkCreate(url);
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      input,
      () => ({ valid: true, issues: [] }),
    );

    expect(result).toEqual({ valid: true, value: input });
    if (!result.valid) return;
    expect(result.value.url).toBe(url);
  });

  it('keeps canonicalUrl distinct and never substitutes it for the caller URL', () => {
    const url = 'https://origin.example.test:443/item?token=A%2fb&token=#Original';
    const canonicalUrl = 'https://canonical.example.test/item';
    const input = { ...bookmarkCreate(url), canonicalUrl };
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      input,
      () => ({ valid: true, issues: [] }),
    );

    expect(result).toEqual({ valid: true, value: input });
    if (!result.valid) return;
    expect(result.value.url).toBe(url);
    expect(result.value.canonicalUrl).toBe(canonicalUrl);
    expect(result.value.url).not.toBe(result.value.canonicalUrl);
  });

  it('preserves an exact sensitive URL at the shared 4096-character boundary', () => {
    const prefix = 'https://example.test/item?opaque=';
    const suffix = '#kept';
    const url = `${prefix}${'A'.repeat(4096 - prefix.length - suffix.length)}${suffix}`;

    expect(url).toHaveLength(4096);
    expect(validators.validate('nodeCreate', bookmarkCreate(url))).toEqual({
      valid: true,
      errors: [],
    });
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      bookmarkCreate(url),
      () => ({ valid: true, issues: [] }),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.url).toBe(url);
    expectUrlError('nodeCreate', bookmarkCreate(`${url}A`));
  });

  it.each([
    'javascript:alert(1)?token=preserve-me',
    'DaTa:text/html,signed?token=preserve-me',
    '/relative/path?token=preserve-me',
    'https://example.test/has space?token=preserve-me',
    'https://example.test/path\n?token=preserve-me',
  ])('does not let preservation make an unsafe Bookmark URL valid: %j', (url) => {
    expectUrlError('node', bookmarkNode(url));
    expectUrlError('nodeCreate', bookmarkCreate(url));
    expectUrlError('nodeMergePatch', { url });

    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      bookmarkCreate(url),
      () => ({ valid: true, issues: [] }),
    );
    expect(result).toEqual(expect.objectContaining({ valid: false, stage: 'structural' }));
  });
});

describe(`CORE-0021 exact preservation through hashes and Snapshots ${evidence}`, () => {
  it('hashes the exact preserved string rather than a normalized equivalent', () => {
    const url = 'HTTPS://EXAMPLE.TEST:443/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep';
    const normalizedAlternative = 'https://example.test/~item?token=A%2Fb&a=1&a=&b=2#Keep';
    const urlHash = createUrlHash(url);

    expect(urlHash).toBe(exactSha256(url));
    expect(urlHash).not.toBe(exactSha256(normalizedAlternative));
    expect(urlHashMatches(url, urlHash)).toBe(true);
    expect(urlHashMatches(normalizedAlternative, urlHash)).toBe(false);
  });

  it('round-trips url, canonicalUrl, and urlHash through validation and Snapshot assembly', () => {
    const snapshot = fixture('collection-snapshot.json') as Snapshot;
    const bookmark = snapshot.nodes[1] as unknown as JsonRecord;
    const url = 'HTTPS://EXAMPLE.TEST:443/%7eitem?b=2&a=&a=1&&opaque=A%2fb#Keep';
    const canonicalUrl = 'https://canonical.example.test/item';
    bookmark.url = url;
    bookmark.canonicalUrl = canonicalUrl;
    bookmark.urlHash = createUrlHash(url);

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });

    const wireRoundTrip = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    const result = assembleSnapshotPages([wireRoundTrip]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const assembled = result.snapshot.nodes[1] as unknown as JsonRecord;
    expect(assembled.url).toBe(url);
    expect(assembled.canonicalUrl).toBe(canonicalUrl);
    expect(assembled.urlHash).toBe(exactSha256(url));
    expect(assembled.canonicalUrl).not.toBe(assembled.url);
    expect(urlHashMatches(assembled.url, assembled.urlHash)).toBe(true);
  });

  it('detects every destructive rewrite once urlHash binds the original string', () => {
    const url = 'HTTP://EXAMPLE.TEST:80/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep';
    const hash = createUrlHash(url);
    const rewrites = [
      'http://example.test/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep',
      'HTTP://EXAMPLE.TEST/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep',
      'HTTP://EXAMPLE.TEST:80/~item?b=2&a=&a=1&&token=A%2Fb#Keep',
      'HTTP://EXAMPLE.TEST:80/%7eitem?a=&a=1&b=2&token=A%2fb#Keep',
      'HTTP://EXAMPLE.TEST:80/%7eitem?b=2&a=1&a=&token=A%2fb#Keep',
      'HTTP://EXAMPLE.TEST:80/%7eitem?b=2&a=&a=1&token=A%2fb',
    ];

    expect(rewrites).not.toContain(url);
    for (const rewritten of rewrites) {
      expect(urlHashMatches(rewritten, hash)).toBe(false);
    }
  });
});

describe(`CORE-0021 client normalization boundary ${evidence}`, () => {
  it('normalizes endpoint URLs without normalizing Bookmark URLs in received Snapshots', async () => {
    const manifest = fixture('public-manifest.json');
    const snapshot = fixture('collection-snapshot.json');
    const url = 'HTTPS://EXAMPLE.TEST:443/%7eitem?b=2&a=&a=1&&token=A%2fb#Keep';
    snapshot.nodes[1].url = url;
    delete snapshot.nodes[1].urlHash;
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      requests.push(requestUrl);
      return new URL(requestUrl).pathname === '/.well-known/collection-protocol'
        ? Response.json(manifest)
        : Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'HTTPS://ALICE.EXAMPLE:443/.well-known/collection-protocol#client-fragment',
      fetch: fetch as typeof globalThis.fetch,
    });

    const received = await client.getSnapshot(collectionId);

    expect(requests[0]).toBe('https://alice.example/.well-known/collection-protocol');
    expect(requests[0]).not.toContain('#client-fragment');
    expect((received.nodes[1] as unknown as JsonRecord).url).toBe(url);
    expect((received.nodes[1] as unknown as JsonRecord).canonicalUrl).not.toBe(url);
    expect(requests).not.toContain(url);
  });
});
