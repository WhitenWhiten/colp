import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { chromeCreate, mappingFor, nativeContent, nodeContent, nodeCreate,
  projectionContent, PullChromeUrlRejected, rejectedChromeBookmarkUrl, setAsideRejectedChromeUrl } from '../src/pull-projection.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const collectionId = 'collection-projection';

function created(kind: 'Bookmark' | 'Folder' | 'Separator', sequence: number) {
  const event = pullFixtures.createEvent({ kind, sequence, collectionId, parentId: 'root' });
  if (event.kind !== 'operation' || event.effect.kind !== 'node_created') throw new Error('fixture_invalid');
  return event.effect.node;
}

describe('Pull native projection', () => {
  test('missing bookmark fields use deterministic fallback projections', () => {
    const node = { ...created('Bookmark', 9), url: undefined, tags: undefined } as never;
    assert.deepEqual(nodeContent(node), { title: 'Remote', url: '' });
    assert.deepEqual(chromeCreate(node), { title: 'Remote', url: '' });
    assert.deepEqual(projectionContent(node), { title: 'Remote', url: '', tags: [] });
    const folder = { ...created('Folder', 10), tags: ['retained'] };
    assert.deepEqual(projectionContent(folder), { title: 'Remote', description: null, tags: ['retained'] });
  });

  test('projects bookmark, folder and separator content for Chrome without protocol metadata', () => {
    const bookmark = created('Bookmark', 1); const folder = created('Folder', 2); const separator = created('Separator', 3);
    assert.deepEqual(nodeContent(bookmark), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(nodeContent(folder), { title: 'Remote' });
    assert.deepEqual(nodeContent(separator), {});
    assert.deepEqual(nodeCreate(bookmark), { kind: 'bookmark', title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(chromeCreate(bookmark), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(chromeCreate(folder), { title: 'Remote' });
    assert.throws(() => chromeCreate(separator), /pull_node_kind_invalid/);
  });

  test('preserves canonical extensions and annotations only in durable projection content', () => {
    const node: any = { ...created('Bookmark', 4), visibility: 'shared', description: 'Description',
      tags: ['tag-a'], extensions: { 'https://example.test/ext': { nested: true } } };
    assert.deepEqual(projectionContent(node), { title: 'Remote', url: 'https://example.test/', visibility: 'shared',
      extensions: { 'https://example.test/ext': { nested: true } }, description: 'Description', tags: ['tag-a'] });
    assert.deepEqual(nativeContent(projectionContent(node)), { title: 'Remote', url: 'https://example.test/' });
    assert.deepEqual(nativeContent({ title: 1, url: null, extensions: {} } as never), {});
  });

  test('an explicit folder clear stays distinguishable from a legacy projection with unknown description', () => {
    const node = { ...created('Folder', 8), description: undefined };
    assert.equal(projectionContent(node).description, null);
    assert.deepEqual(nativeContent(projectionContent(node)), { title: 'Remote' });
  });

  test('keeps a folder role only when the remote node declares one', () => {
    const node = { ...created('Folder', 13), folderRole: 'bookmarks-bar' } as never;
    assert.deepEqual(projectionContent(node),
      { title: 'Remote', folderRole: 'bookmarks-bar', description: null });
  });

  test('creates a canonical mapping with stable content digests and optional parent identities', () => {
    const node = created('Bookmark', 5);
    const mapping = mappingFor(node, 'native-node', 'native-parent', 'parent', null, 'native-root');
    assert.deepEqual({ nativeId: mapping.nativeId, colpId: mapping.colpId, nodeKind: mapping.nodeKind,
      parentNativeId: mapping.parentNativeId, parentColpId: mapping.parentColpId,
      content: mapping.projection.content }, {
      nativeId: 'native-node', colpId: node.id, nodeKind: 'bookmark', parentNativeId: 'native-parent',
      parentColpId: 'parent', content: { title: 'Remote', url: 'https://example.test/', tags: [] } });
    assert.match(mapping.projection.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(mapping.projection.contentDigest ?? '', /^sha256:[0-9a-f]{64}$/u);
    const detached = mappingFor(node, 'native-node', null, null, null, 'native-root');
    assert.equal('parentNativeId' in detached, false); assert.equal('parentColpId' in detached, false);
  });

  test('refuses file and chrome urls before they can be passed to chrome.bookmarks.create', () => {
    const bookmark = created('Bookmark', 11);
    assert.deepEqual(chromeCreate({ ...bookmark, url: 'https://example.test/kept' } as never),
      { title: 'Remote', url: 'https://example.test/kept' });
    assert.deepEqual(chromeCreate({ ...bookmark, url: 'http://example.test/kept' } as never),
      { title: 'Remote', url: 'http://example.test/kept' });
    assert.deepEqual(chromeCreate(created('Folder', 12)), { title: 'Remote' });
    for (const url of ['file:///tmp/secret', 'FILE:///tmp/secret', 'chrome://settings', 'Chrome://bookmarks/']) {
      assert.throws(() => chromeCreate({ ...bookmark, url } as never), (error: unknown) =>
        error instanceof PullChromeUrlRejected && error.code === 'unsupported_url_scheme');
    }
  });

  test('rejects root, alias and separator shapes that Chrome cannot create directly', () => {
    const root = { ...created('Folder', 6), kind: 'root' } as never;
    const alias = { ...created('Bookmark', 7), kind: 'alias' } as never;
    for (const candidate of [root, alias]) {
      assert.throws(() => nodeContent(candidate), /pull_node_kind_invalid/);
      assert.throws(() => nodeCreate(candidate), /pull_node_kind_invalid/);
      assert.throws(() => chromeCreate(candidate), /pull_node_kind_invalid/);
      assert.throws(() => mappingFor(candidate, 'native', null, null, null, 'native-root'),
        /pull_node_kind_invalid/);
    }
  });

  test('classifies a representable but unfetchable URL as invalid_url', () => {
    assert.equal(rejectedChromeBookmarkUrl('https://example.test/'), null);
    assert.equal(rejectedChromeBookmarkUrl('https://user:password@example.test/'), 'invalid_url');
  });

  test('sets aside a rejected URL only on a still-open event with a node identity', async () => {
    const writes: unknown[] = [];
    let current: { readonly state: string } | null = { state: 'staged' };
    const store = {
      async getPullEvent() { return current; },
      async setAsidePullEvent(_scope: unknown, _eventId: string, issue: unknown) { writes.push(issue); },
    };
    const scope = {} as never;
    const rejected = (code: 'invalid_url' | 'unsupported_url_scheme') => new PullChromeUrlRejected(code);
    const withNode = { effect: { kind: 'node_created', node: { id: 'colp-1', title: 'Remote' } } };

    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1', withNode,
      new Error('not-a-url-rejection'), 5), false);
    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1', { effect: {} },
      rejected('invalid_url'), 5), false);
    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1',
      { effect: { node: { id: 1 } } }, rejected('invalid_url'), 5), false);

    current = null;
    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1', withNode,
      rejected('invalid_url'), 5), false);
    current = { state: 'terminal' };
    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1', withNode,
      rejected('invalid_url'), 5), false);

    current = { state: 'staged' };
    assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-1', withNode,
      rejected('unsupported_url_scheme'), 5), true);
    assert.deepEqual(writes, [{ code: 'unsupported_url_scheme', nodeId: 'colp-1', title: 'Remote', now: 5 }]);
  });

  test('set-aside keeps a prepared event and omits empty or absent titles', async () => {
    const writes: unknown[] = [];
    const store = {
      async getPullEvent() { return { state: 'intent_prepared' }; },
      async setAsidePullEvent(_scope: unknown, _eventId: string, issue: unknown) { writes.push(issue); },
    };
    const scope = {} as never;
    for (const [title, expected] of [
      [undefined, { code: 'invalid_url', nodeId: 'colp-2', now: 7 }],
      ['', { code: 'invalid_url', nodeId: 'colp-2', now: 7 }],
    ] as const) {
      assert.equal(await setAsideRejectedChromeUrl(store as never, scope, 'event-2',
        { effect: { node: { id: 'colp-2', ...(title === undefined ? {} : { title }) } } },
        new PullChromeUrlRejected('invalid_url'), 7), true);
      assert.deepEqual(writes.at(-1), expected);
    }
  });
});
