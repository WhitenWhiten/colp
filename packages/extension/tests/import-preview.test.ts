import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { describe, test } from 'vitest';

import {
  DEFAULT_IMPORT_LIMITS,
  ImportPreviewError,
  normalizeChromeBookmarkTree,
  previewChromeBookmarkImport,
  previewNetscapeBookmarkImport,
} from '../src/import-preview.js';

const fixture = (name: string) => readFile(resolve('tests/fixtures', name));

describe('P3-34 Netscape bookmark preview', () => {
  test('parses a real Chromium export into a normalized tree and public COLP preview', async () => {
    const result = previewNetscapeBookmarkImport(await fixture('chrome-bookmarks-export.html'));
    assert.equal(createValidatorRegistry().validate('conversionPreview', result.preview).valid, true);
    assert.equal(result.source.profile, 'netscape-bookmarks-v1');
    assert.match(result.source.identity, /^sha256:[0-9a-f]{64}$/u);
    assert.match(result.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.preview.creates, 7);
    assert.deepEqual(result.tree.map((node) => node.kind), ['Folder', 'Folder']);
    assert.equal(result.tree[0]?.title, 'Bookmarks bar');
    assert.equal(result.tree[0]?.folderRole, 'bookmarks-bar');
    assert.equal(result.tree[0]?.createdAt, '2024-03-09T16:00:00.000Z');
    assert.equal(result.tree[0]?.childrenModifiedAt, '2024-03-09T16:01:40.000Z');
    assert.equal(result.tree[0]?.children[0]?.title, 'Example & reference');
    assert.equal(result.tree[0]?.children[0]?.url, 'https://example.com/?a=1&b=2');
    assert.equal(result.tree[0]?.children[1]?.title, 'Research 与设计');
    assert.equal(result.tree[0]?.children[2]?.kind, 'Separator');
    assert.ok(result.preview.warnings.some((warning) => warning.code === 'favicon_sidecar_only'));
    assert.ok(result.preview.warnings.some((warning) => warning.code === 'unsupported_url_scheme'));
  });

  test('handles mixed-case tags, entities, missing attributes, separators and unknown attributes', () => {
    const result = previewNetscapeBookmarkImport(new TextEncoder().encode(`<!doctype netscape-bookmark-file-1>
      <dL><P><Dt><h3 PERSONAL_TOOLBAR_FOLDER="true" CUSTOM="x&amp;y">Tools &amp; Docs</H3>
      <Dl><p><DT><a HrEf="https://example.test/a?x=1&amp;y=2" TAGS="a,b">A &lt; B</A>
      <dt><A>no href</a><DT><HR></dl></DL>`));
    assert.equal(result.tree[0]?.title, 'Tools & Docs');
    assert.equal(result.tree[0]?.children[0]?.title, 'A < B');
    assert.equal(result.tree[0]?.children[0]?.url, 'https://example.test/a?x=1&y=2');
    assert.equal(result.tree[0]?.children[1]?.kind, 'Separator');
    assert.equal(result.preview.creates, 3);
    assert.equal(result.preview.lossy, 1);
    assert.ok(result.preview.warnings.some((warning) => warning.code === 'bookmark_missing_href'));
    assert.deepEqual(result.tree[0]?.extensions?.['https://know-n.com/colp/ns/netscape-bookmark-html/v1'], {
      attributes: { CUSTOM: 'x&y' },
    });
  });

  test('preserves duplicate URL/title occurrences as distinct source identities with reviewable warnings', () => {
    const html = new TextEncoder().encode('<DL><DT><A HREF="https://same.example/">Same</A><DT><A HREF="https://same.example/">Same</A></DL>');
    const result = previewNetscapeBookmarkImport(html);
    assert.equal(result.tree.length, 2);
    assert.notEqual(result.tree[0]?.sourceNodeId, result.tree[1]?.sourceNodeId);
    assert.equal(result.preview.creates, 2);
    assert.equal(result.preview.warnings.filter((warning) => warning.code === 'duplicate_candidate').length, 1);
    assert.equal(result.preview.lossy, 0);
  });

  test('keeps hostile Netscape and Chrome input inert with zero external side effects', async () => {
    let fetchCalls = 0; let domAccesses = 0; let storageAccesses = 0; let chromeAccesses = 0; let logCalls = 0;
    const priorFetch = globalThis.fetch;
    const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const priorIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const priorChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const priorConsole = Object.getOwnPropertyDescriptor(globalThis, 'console');
    const priorMarker = (globalThis as Record<string, unknown>).__KNOWN_IMPORT_SCRIPT_EXECUTED__;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { fetchCalls += 1; throw new Error('network'); } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: new Proxy({}, { get() { domAccesses += 1; throw new Error('dom'); } }) });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new Proxy({}, { get() { storageAccesses += 1; throw new Error('storage'); } }) });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: new Proxy({}, { get() { chromeAccesses += 1; throw new Error('chrome'); } }) });
    Object.defineProperty(globalThis, 'console', { configurable: true, value: new Proxy({}, { get() { return () => { logCalls += 1; }; } }) });
    try {
      const result = previewNetscapeBookmarkImport(await fixture('netscape-malicious.html'));
      const chromeResult = previewChromeBookmarkImport([{ id: '0', title: '', children: [
        { id: '1', parentId: '0', index: 0, title: 'unsafe', url: 'javascript:alert(1)' },
        { id: '2', parentId: '0', index: 1, title: 'local', url: 'file:///C:/private/secret.txt' },
      ] }]);
      assert.equal((globalThis as Record<string, unknown>).__KNOWN_IMPORT_SCRIPT_EXECUTED__, priorMarker);
      assert.equal(fetchCalls, 0); assert.equal(domAccesses, 0); assert.equal(storageAccesses, 0);
      assert.equal(chromeAccesses, 0); assert.equal(logCalls, 0);
      assert.equal(result.tree.some((node) => node.url?.startsWith('javascript:')), false);
      assert.equal(result.tree.some((node) => node.url?.startsWith('file:')), true);
      assert.deepEqual(chromeResult.tree.map((node) => node.url), ['file:///C:/private/secret.txt']);
      assert.ok(result.preview.warnings.some((warning) => warning.code === 'unsafe_element_ignored'));
      assert.equal(new Set(result.preview.warnings.filter((warning) => warning.code === 'unsafe_element_ignored')
        .map((warning) => warning.path)).size, 2);
      assert.ok(result.preview.warnings.some((warning) => warning.code === 'unsupported_url_scheme' && warning.lossy === true));
      assert.ok(chromeResult.preview.warnings.some((warning) => warning.code === 'unsupported_url_scheme' && warning.lossy === true));
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: priorFetch });
      if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete (globalThis as Record<string, unknown>).document;
      if (priorIndexedDb) Object.defineProperty(globalThis, 'indexedDB', priorIndexedDb); else delete (globalThis as Record<string, unknown>).indexedDB;
      if (priorChrome) Object.defineProperty(globalThis, 'chrome', priorChrome); else delete (globalThis as Record<string, unknown>).chrome;
      if (priorConsole) Object.defineProperty(globalThis, 'console', priorConsole);
    }
  });

  test('rejects malformed UTF-8, JSON, Chromium Bookmarks JSON and non-Netscape HTML with visible codes', () => {
    assert.throws(() => previewNetscapeBookmarkImport(Uint8Array.from([0xff, 0xfe, 0x00])),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'input_invalid');
    const json = new TextEncoder().encode('{"checksum":"x","roots":{"bookmark_bar":{"children":[]}}}');
    assert.throws(() => previewNetscapeBookmarkImport(json),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'unsupported_format');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('url,title\nhttps://a.test,A')),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'unsupported_format');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('<html><p>not bookmarks</p></html>')),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'unsupported_format');
    assert.throws(() => previewNetscapeBookmarkImport(new Uint8Array()),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'import_empty');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL>')),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'import_empty');
    assert.throws(() => previewChromeBookmarkImport({ checksum: 'x', roots: { bookmark_bar: { children: [] } } }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'chrome_tree_invalid');
    assert.throws(() => previewChromeBookmarkImport('{"id":"0"}'),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'chrome_tree_invalid');
    assert.throws(() => previewChromeBookmarkImport([{ id: '0', title: '', children: [] }]),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'import_empty');
  });

  test('S-04 import preview refuses above the Snapshot node cap before accepting data', () => {
    assert.equal(DEFAULT_IMPORT_LIMITS.maxNodes, 10_000);
  });

  test('enforces the byte cap before parsing and depth/node/member budgets during conversion', () => {
    assert.throws(() => previewNetscapeBookmarkImport(new Uint8Array(DEFAULT_IMPORT_LIMITS.maxInputBytes + 1)),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'input_too_large');
    const nested = `${'<DL><DT><H3>x</H3>'.repeat(5)}${'</DL>'.repeat(5)}`;
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode(nested), { maxDepth: 3 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'depth_limit');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('<DL><DT><A HREF="https://a.test">a</A><DT><HR></DL>'), { maxNodes: 1 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'node_limit');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('<DL><DT><A HREF="https://a.test" A="1" B="2">a</A></DL>'), { maxMembers: 1 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'member_limit');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('<DIV><SPAN>x</SPAN></DIV>'), { maxNodes: 1 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'node_limit');
    assert.throws(() => previewNetscapeBookmarkImport(new TextEncoder().encode('<DIV A="1" B="2">ignored</DIV>'), { maxMembers: 1 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'member_limit');
  });

  test('returns identical source identity, canonical tree and digest for repeated preview', async () => {
    const input = await fixture('chrome-bookmarks-export.html');
    const first = previewNetscapeBookmarkImport(input); const second = previewNetscapeBookmarkImport(input);
    assert.deepEqual(second, first);
    assert.equal(second.source.identity, first.source.identity);
    assert.equal(second.digest, first.digest);
  });

  test('retains raw ICON on the tree for digest without decoding, fetching, or unknown-extension warnings', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const other = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    const icon = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    const html = (value: string) => new TextEncoder().encode(
      `<DL><DT><A HREF="https://example.test/" ICON="${value}">Example</A></DL>`,
    );
    const fetched: string[] = [];
    const priorFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (url: unknown) => { fetched.push(String(url)); throw new Error('preview must not fetch'); },
    });
    try {
      const first = previewNetscapeBookmarkImport(html(icon(png)));
      const second = previewNetscapeBookmarkImport(html(icon(other)));
      const uriOnly = previewNetscapeBookmarkImport(new TextEncoder().encode(
        '<DL><DT><A HREF="https://example.test/" ICON_URI="https://cdn.example/favicon.ico">Example</A></DL>',
      ));
      assert.equal(first.tree[0]?.icon, icon(png));
      assert.notEqual(first.digest, second.digest);
      assert.equal(first.tree[0]?.extensions, undefined);
      assert.ok(first.preview.warnings.some((warning) => warning.code === 'favicon_sidecar_only'));
      assert.ok(!first.preview.warnings.some((warning) => warning.code === 'unknown_extension_preserved_remote_only'));
      assert.ok(uriOnly.preview.warnings.some((warning) => warning.code === 'favicon_sidecar_only'));
      assert.equal(uriOnly.tree[0]?.icon, undefined);
      assert.deepEqual(fetched, []);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: priorFetch });
    }
  });
});

describe('P3-34 Chrome native tree preview', () => {
  const chromeTree = () => [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', index: 0, title: 'Bar', type: 'folder' as const, folderType: 'bookmarks-bar' as const,
      dateAdded: 1_710_000_000_000, dateGroupModified: 1_710_000_100_000, syncing: true,
      children: [
        { id: '2', parentId: '1', index: 0, title: 'Example', url: 'https://example.test/',
          dateAdded: 1_710_000_200_000, dateLastUsed: 1_710_000_300_000 },
        { id: '3', parentId: '1', index: 1, title: 'Example', url: 'https://example.test/' },
      ] },
    { id: '4', parentId: '0', index: 1, title: 'Other', type: 'folder' as const, folderType: 'other' as const, children: [] },
  ] }];

  test('converts Chrome roots, native metadata and duplicates without identity dedupe', () => {
    const result = previewChromeBookmarkImport(chromeTree());
    assert.equal(createValidatorRegistry().validate('conversionPreview', result.preview).valid, true);
    assert.equal(result.source.profile, 'chromium-bookmarks-v1');
    assert.equal(result.preview.creates, 4);
    assert.equal(result.tree[0]?.folderRole, 'bookmarks-bar');
    assert.equal(result.tree[0]?.children.length, 2);
    assert.notEqual(result.tree[0]?.children[0]?.sourceNodeId, result.tree[0]?.children[1]?.sourceNodeId);
    assert.equal(result.tree[0]?.children[0]?.sourceRef.nativeId, '2');
    assert.equal(result.tree[0]?.children[0]?.sourceRef.nativeParentId, '1');
    assert.equal(result.tree[0]?.children[0]?.createdAt, '2024-03-09T16:03:20.000Z');
    assert.equal(result.tree[0]?.children[0]?.lastUsedAt, '2024-03-09T16:05:00.000Z');
    assert.equal(result.tree[0]?.sourceRef.syncing, true);
    assert.ok(result.preview.warnings.some((warning) => warning.code === 'duplicate_candidate'));
  });

  test('is deterministic for equivalent native input regardless of object member insertion order', () => {
    const first = previewChromeBookmarkImport(chromeTree());
    const equivalent = [{ children: [
      { children: [
        { dateLastUsed: 1_710_000_300_000, dateAdded: 1_710_000_200_000, url: 'https://example.test/', title: 'Example', index: 0, parentId: '1', id: '2' },
        { url: 'https://example.test/', title: 'Example', index: 1, parentId: '1', id: '3' },
      ], syncing: true, dateGroupModified: 1_710_000_100_000, dateAdded: 1_710_000_000_000,
        folderType: 'bookmarks-bar', type: 'folder', title: 'Bar', index: 0, parentId: '0', id: '1' },
      { children: [], folderType: 'other', type: 'folder', title: 'Other', index: 1, parentId: '0', id: '4' },
    ], title: '', id: '0' }];
    const second = previewChromeBookmarkImport(equivalent);
    assert.deepEqual(second, first);
  });

  test('rejects cycles, duplicate IDs, illegal parent/child/root shapes and invalid ordering', () => {
    const cyclic: any = { id: '0', title: '', children: [] }; cyclic.children.push(cyclic);
    const invalid = [
      [cyclic],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', title: 'a' }, { id: 'x', parentId: '0', title: 'b' }] }],
      [{ id: '0', title: '', url: 'https://root.invalid/', children: [] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: 'wrong', title: 'x' }] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', title: 'x', url: 'https://x.test/', children: [{ id: 'y', parentId: 'x', title: 'y' }] }] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', index: 2, title: 'x' }] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', title: 'x', url: 'https://x.test/' }] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', index: 0, title: 'x', type: 'folder' }] }],
      [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', index: 0, title: 'x', url: 'https://x.test/', children: [] }] }],
      [],
      [{ id: '0', title: '' }, { id: '1', title: '' }],
    ];
    for (const value of invalid) assert.throws(() => previewChromeBookmarkImport(value),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'chrome_tree_invalid');
  });

  test('rejects Chrome depth, node and member budget overflow', () => {
    const deep = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', index: 0, title: '1', children: [
      { id: '2', parentId: '1', index: 0, title: '2', children: [] },
    ] }] }];
    assert.throws(() => previewChromeBookmarkImport(deep, { maxDepth: 1 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'depth_limit');
    assert.throws(() => previewChromeBookmarkImport(chromeTree(), { maxNodes: 2 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'node_limit');
    assert.throws(() => previewChromeBookmarkImport([{ id: '0', title: '', extra: 1, children: [] }], { maxMembers: 3 }),
      (error: unknown) => error instanceof ImportPreviewError && error.code === 'member_limit');
  });

  test('normalizes live Chrome trees that include extra keys, getters and omitted indexes', () => {
    const bookmark = Object.defineProperties({}, {
      id: { enumerable: true, get: () => '2' },
      parentId: { enumerable: true, get: () => '1' },
      title: { enumerable: true, get: () => 'Example' },
      url: { enumerable: true, get: () => 'https://example.test/' },
      guid: { enumerable: true, get: () => 'bookmark-guid' },
    });
    const bar = Object.defineProperties({}, {
      id: { enumerable: true, get: () => '1' },
      parentId: { enumerable: true, get: () => '0' },
      title: { enumerable: true, get: () => 'Bar' },
      folderType: { enumerable: true, get: () => 'bookmarks-bar' },
      dateLastUsed: { enumerable: true, get: () => 1_710_000_300_000 },
      children: { enumerable: true, get: () => [bookmark] },
    });
    const root = Object.defineProperties({}, {
      id: { enumerable: true, get: () => '0' },
      title: { enumerable: true, get: () => '' },
      guid: { enumerable: true, get: () => 'root-guid' },
      children: { enumerable: true, get: () => [bar] },
    });
    const result = previewChromeBookmarkImport(normalizeChromeBookmarkTree([root]));
    assert.equal(result.source.profile, 'chromium-bookmarks-v1');
    assert.equal(result.tree[0]?.title, 'Bar');
    assert.equal(result.tree[0]?.folderRole, 'bookmarks-bar');
    assert.equal(result.tree[0]?.children[0]?.url, 'https://example.test/');
    assert.equal(result.tree[0]?.children[0]?.sourceRef.nativeIndex, 0);
  });

  test('normalizes separators with empty URLs, numeric ids, empty bookmark children and extra top-level roots', () => {
    const numeric = [{ id: 0, title: '', children: [
      { id: 1, parentId: 0, title: 'Bar', type: 'folder', children: [
        { id: 2, parentId: 1, title: '', type: 'separator', url: '' },
        { id: 3, parentId: 1, title: 'Example', url: 'https://example.test/', children: [] },
        { id: 4, parentId: 1, title: 'Folder', type: 'folder', url: 'https://ignore.example/', children: [] },
      ] },
    ] }];
    const first = previewChromeBookmarkImport(normalizeChromeBookmarkTree(numeric));
    assert.equal(first.tree[0]?.children[0]?.kind, 'Separator');
    assert.equal(first.tree[0]?.children[1]?.url, 'https://example.test/');
    assert.equal(first.tree[0]?.children[2]?.kind, 'Folder');
    assert.equal(first.tree[0]?.children[2]?.url, undefined);
    const extras = [
      { id: 'bar', title: 'Bar', children: [{ id: 'a', title: 'A', url: 'https://a.example/' }] },
      { id: 'other', title: 'Other', children: [] },
    ];
    const wrapped = previewChromeBookmarkImport(normalizeChromeBookmarkTree(extras));
    assert.equal(wrapped.tree.map((node) => node.title).join(','), 'Bar,Other');
    assert.equal(wrapped.tree[0]?.children[0]?.url, 'https://a.example/');
  });
});
