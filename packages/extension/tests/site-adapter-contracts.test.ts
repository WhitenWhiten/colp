import { siteDisplayTitle } from '../src/site-adapters/title.js';
import { parseManagedSave } from '../../server/src/modules/source-archives/managed-copies.js';
import { describe, expect, test } from 'vitest';
import { validAdapterMessage, validBootstrap, validHostCommand, validMembershipResult, validObservation, validPageResult } from '../src/site-adapters/schemas.js';
import { jsonBytes } from '../src/site-adapters/schema.js';
import { validateCollectionGraph } from '../src/site-adapters/graph.js';
import { aidFromItem, collection, decimal, detail, resolveAvUrl, validBilibiliItem } from '../src/site-adapters/bilibili/identity.js';
import { envelope, fixtures, observation, partialPage, video } from './fixtures/site-adapters/bilibili.js';
describe('site adapter v1 trust boundary', () => {
  test('accepts closed bootstrap, observation, partial/error pages and command', () => {
    expect(validBootstrap({ protocolVersion: 1, operation: 'hello', runtime: 'bundled', activationId: 'activation-1', adapterId: 'bundled.bilibili', source: { state: 'signedIn', accountId: '42' } })).toBe(true);
    expect(validObservation(observation)).toBe(true);
    expect(validAdapterMessage({ ...envelope, operation: 'emit', data: observation })).toBe(true);
    expect(validPageResult(partialPage)).toBe(true);
    expect(validPageResult({ status: 'failed', error: { code: 'staleCursor' } })).toBe(true);
    expect(validHostCommand({ operation: 'resolveItem', leaseId: 'lease-1', resolutionId: 'r1', url: video.url, deadlineAt: 30000 })).toBe(true);
  });
  test.each([
    { ...envelope, operation: 'emit', data: { ...observation, userGesture: true } },
    { ...envelope, operation: 'emit', data: { ...observation, memberships: { mode: 'delta', added: ['101'], removed: ['101'] } } },
    { ...envelope, operation: 'emit', data: { ...observation, memberships: { mode: 'complete', collectionIds: ['101', '101'] } } },
    { ...envelope, operation: 'emit', data: { ...observation, item: { ...video, url: 'javascript:alert(1)' } } },
    { ...envelope, operation: 'emit', data: { ...observation, item: { ...video, url: 'https://token:secret@www.bilibili.com/video/av1' } } },
    { ...envelope, operation: 'read', recipeId: 'fetch', params: { url: 'https://example.org/' } },
    { ...envelope, operation: 'executePlannedSave', planId: 'evil' },
  ])('rejects authority expansion and invalid shape %#', value => expect(validAdapterMessage(value)).toBe(false));
  test('enforces byte, entity, nesting and finite number bounds', () => {
    expect(validPageResult({ ...partialPage, page: { ...partialPage.page, items: Array.from({ length: 101 }, (_, i) => ({ item: { ...video, id: String(i) } })) } })).toBe(false);
    expect(jsonBytes({ x: Infinity }, 100)).toBe(false);
    expect(jsonBytes({ x: '中'.repeat(100) }, 200)).toBe(false);
    let deep: unknown = null; for (let i = 0; i < 35; i++) deep = [deep];
    expect(jsonBytes(deep, 10000)).toBe(false);
    expect(validObservation({ type: 'catalog.upsert' })).toBe(false);
    expect(validBootstrap({ protocolVersion: 2, operation: 'hello', runtime: 'bundled', activationId: 'activation-1', adapterId: 'x', source: { state: 'unknown' } })).toBe(false);
  });
  test('readback has exactly one result per requested edge', () => {
    const query = { itemId: video.id, collectionIds: ['101', '102'] };
    const edges = [{ collectionId: '101', state: 'present', evidence: { kind: 'siteResponse', operation: 'ids.fresh' } }, { collectionId: '102', state: 'unknown', reason: 'ambiguousState' }];
    expect(validMembershipResult({ status: 'ok', itemId: video.id, edges }, query)).toBe(true);
    for (const bad of [edges.slice(0, 1), [edges[0], edges[0]], [...edges, { collectionId: '103', state: 'unknown', reason: 'notVisible' }]])
      expect(validMembershipResult({ status: 'ok', itemId: video.id, edges: bad }, query)).toBe(false);
    expect(validMembershipResult({ status: 'ok', itemId: 'other', edges }, query)).toBe(false);
  });
  test('keeps IDs distinct from labels and URLs and distinguishes omitted/invalid/unsupported', () => {
    const cs = fixtures.catalog.data.list.map(collection);
    expect(cs[0]?.id).not.toEqual(cs[1]?.id);
    expect(collection({ title: '101' })).toBeNull();
    expect(decimal(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(decimal('01')).toBeNull();
    expect(aidFromItem(video.id)).toBe('1');
    expect(resolveAvUrl(`${video.url}/?p=2#x`)).toBe('1');
    expect(resolveAvUrl('https://b23.tv/short')).toBeNull();
    expect(resolveAvUrl('https://space.bilibili.com/video/av1')).toBeNull();
    expect(validBilibiliItem({ ...video, id: 'video:av:2' })).toBe(false);
    expect(detail(fixtures.details.data[0]).status).toBe('ok');
    expect(detail(fixtures.details.data[1]).status).toBe('invalid');
    expect(detail({ id: 3, type: 12, title: 'Article' }).status).toBe('unsupported');
    expect(detail(undefined).status).toBe('missing');
  });
  test('rejects cyclic and unresolved ancestry', () => {
    expect(validateCollectionGraph([{ id: '1', identity: 'siteId', title: 'A', parentId: null }])).toBe(true);
    expect(validateCollectionGraph([{ id: '1', identity: 'siteId', title: 'A', parentId: '1' }])).toBe(false);
    expect(validateCollectionGraph([{ id: '1', identity: 'siteId', title: 'A' }])).toBe(false);
  });
});

test.each(['x'.repeat(600), 'Line one\nLine two', 'x'.repeat(511) + '😀'])('source display projection satisfies the shared save contract', raw => {
  const title = siteDisplayTitle(raw)!;
  const result = detail({ id: 1, type: 2, title: raw });
  expect(result).toMatchObject({ status: 'ok', item: { title } });
  expect(validObservation({ ...observation, item: { ...video, title } })).toBe(true);
  expect(() => parseManagedSave({ commandId: 'save', replicaId: 'replica', collectionId: 'library', parentId: 'folder', parentRevision: 'r1', title, url: video.url,
    slot: { kind: 'bookmark', copy: { purpose: 'sourceArchive', sourceAccount: '42', sourceCollectionId: '101', content: { site: 'bilibili', identityVersion: 1, itemId: video.id, accountId: null } } } })).not.toThrow();
  expect(validObservation({ ...observation, item: { ...video, title: raw } })).toBe(false);
});
