import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { createValidatorRegistry, type DefinitionName } from '../../src/schema/index.js';
import { isBookmarkUrl } from '../../src/schema/uri.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function expectUrlError(definition: DefinitionName, value: unknown, path: string): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ instancePath: path })]),
  );
}

describe('Bookmark URL contract [evidence:schema.bookmark-url]', () => {
  it.each([
    'http://example.com/bookmark',
    'https://example.com/bookmark?q=one#two',
    'file:///C:/Users/Alice/bookmarks.html',
    'about:blank',
    'chrome-extension://abcdefghijklmnop/options.html',
    'web+notes:item/42',
  ])('accepts safe absolute URI %s', (url) => {
    expect(validators.validate('bookmarkUrl', url)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'VbScRiPt:msgbox(1)',
    'DaTa:text/html,<script>alert(1)</script>',
  ])('rejects executable scheme %s case-insensitively', (url) => {
    expect(validators.validate('bookmarkUrl', url).valid).toBe(false);
  });

  it.each([
    '',
    '/relative/bookmark',
    'example.com/no-scheme',
    'https://exa mple.com/',
    ' https://example.com/',
    'https://example.com/\nnext',
    'https://example.com/\u0000tail',
    'https://example.com/\u007ftail',
    'https://[invalid',
  ])('rejects relative, malformed, whitespace, or control-bearing value %j', (url) => {
    expect(validators.validate('bookmarkUrl', url).valid).toBe(false);
  });

  it.each([
    'https://example.com/',
    'HTTP://EXAMPLE.COM/path',
    'file:///tmp/bookmarks.html',
    'about:blank',
    'chrome://bookmarks/',
    'edge://favorites/',
    'moz-extension://01234567-89ab-cdef-0123-456789abcdef/page.html',
    'web+notes:item/42',
    'javascript:alert(1)',
    'VBScript:msgbox(1)',
    'DATA:text/plain,hello',
    '/relative',
    'https://example.com/has space',
    'https://example.com/\u0000tail',
    'https://[invalid',
  ])('keeps the shared Bookmark predicate in exact parity for %j', (url) => {
    expect(isBookmarkUrl(url)).toBe(validators.validate('bookmarkUrl', url).valid);
  });

  it.each([
    {
      definition: 'node' as const,
      path: '/url',
      build(url: string) {
        const snapshot = fixture('sync-snapshot.json');
        return { ...snapshot.nodes[1], url };
      },
    },
    {
      definition: 'nodeCreate' as const,
      path: '/url',
      build: (url: string) => ({ kind: 'bookmark', title: 'Unsafe', url }),
    },
    {
      definition: 'nodeMergePatch' as const,
      path: '/url',
      build: (url: string) => ({ url }),
    },
  ])('applies bookmarkUrl to $definition at $path', ({ definition, path, build }) => {
    expect(validators.validate(definition, build('about:blank')).valid).toBe(true);
    expectUrlError(definition, build('jAvAsCrIpT:alert(1)'), path);
  });

  it('rejects an executable URL in direct Sync semantics at the exact Node path', () => {
    const snapshot = fixture('sync-snapshot.json') as unknown as Snapshot;
    (snapshot.nodes[1] as { url: string }).url = 'JaVaScRiPt:alert(1)';

    expect(validateSnapshotSemantics(snapshot)).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_bookmark_url',
          path: '/nodes/1/url',
        }),
      ]),
    });
  });

  it('keeps publication HTTP(S) restriction distinct from executable-scheme rejection', () => {
    const snapshot = fixture('collection-snapshot.json') as unknown as Snapshot;
    (snapshot.nodes[1] as { url: string }).url = 'file:///C:/Users/Alice/bookmarks.html';

    expect(validators.validate('snapshot', snapshot).valid).toBe(true);
    expect(validateSnapshotSemantics(snapshot)).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'unsafe_publication_scheme',
          path: '/nodes/1/url',
        }),
      ]),
    });
  });

  it.each(['protected', 'private'] as const)(
    'allows a %s publication Bookmark to be redacted only when URL is omitted',
    (visibility) => {
      const snapshot = fixture('collection-snapshot.json') as unknown as Snapshot;
      const bookmark = snapshot.nodes[1] as unknown as Record<string, unknown>;
      delete bookmark.url;
      delete bookmark.canonicalUrl;
      bookmark.redacted = true;
      bookmark.visibility = visibility;
      (snapshot as { annotations: unknown[] }).annotations = [];

      expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
      expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
      bookmark.url = 'https://example.com/private';
      expect(validators.validate('snapshot', snapshot).valid).toBe(false);
      delete bookmark.url;
      bookmark.visibility = 'public';
      expect(validators.validate('snapshot', snapshot).valid).toBe(false);
    },
  );

  it('rejects a redacted Bookmark outside a publication Snapshot', () => {
    const snapshot = fixture('sync-snapshot.json') as unknown as Snapshot;
    const bookmark = snapshot.nodes[1] as unknown as Record<string, unknown>;
    delete bookmark.url;
    delete bookmark.canonicalUrl;
    bookmark.redacted = true;
    bookmark.visibility = 'private';

    expect(validators.validate('snapshot', snapshot).valid).toBe(false);
    expect(validateSnapshotSemantics(snapshot)).toEqual({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'redacted_node_outside_publication',
          path: '/nodes/1/redacted',
        }),
      ]),
    });
  });

  it('offers no context option that widens Bookmark URLs beyond HTTP(S)', () => {
    const snapshot = fixture('collection-snapshot.json') as unknown as Snapshot;
    (snapshot.nodes[1] as { url: string }).url = 'file:///C:/private.html';

    const result = validateSnapshotSemantics(snapshot, {
      publicationSchemes: new Set(['file:']),
    } as never);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unsafe_publication_scheme', path: '/nodes/1/url' }),
        ]),
      );
    }
  });

  it('makes the publication client report unsafe Bookmark structure before semantics', async () => {
    const manifest = fixture('public-manifest.json');
    const snapshot = fixture('collection-snapshot.json');
    snapshot.nodes[1].url = 'jAvAsCrIpT:alert(1)';
    snapshot.collection.rootNodeId = 'missing-root';
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return url.pathname === '/.well-known/collection-protocol'
        ? Response.json(manifest)
        : Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
    });
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    const receive = client.getSnapshot(collectionId);
    await expect(receive).rejects.toThrow('Response does not satisfy snapshot');
    await expect(receive).rejects.not.toThrow('semantic validation failed');
  });
});
