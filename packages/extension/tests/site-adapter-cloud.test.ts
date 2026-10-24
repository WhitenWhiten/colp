import { sourceConnectionKey, sourceInput } from '../../server/src/modules/source-archives/index.js';
import { cloudEdgeUnseen, cloudProgress } from '../src/site-adapters/cloud-progress.js';
import { test, expect } from 'vitest';
import { sourceDigest } from '../src/site-adapters/source-db.js';
import { createSourceCloudClient, assertSourceCloudProfile, assertCloudReceipt, type CloudScope } from '../src/site-adapters/cloud-client.js';
import { sourceHash, parseSourceScope, parseSourceEdges, SOURCE_ARCHIVE_PROFILE } from '../../server/src/modules/source-archives/index.js';
const scope: CloudScope = { site: 'bilibili', identityVersion: 1, sourceAccount: '42', collectionId: 'library',
  roots: [{ ruleId: 'B-only', nodeId: 'canonical-root', resourceRevision: 'revision', collectionIds: ['101'] }],
  policy: { revision: 1, copies: 'sourceAndSemantic', backgroundClassification: 'disabled', sourceRemoval: 'retainArchive' }, rulesDigest: sourceDigest({ z: 2, A: 1 }), bindingDigest: sourceDigest({ native: 'private' }) };
const edges = [{ itemId: 'video:av:1', collectionId: '101', collectionTitle: 'B', title: 'Video', url: 'https://www.bilibili.com/video/av1', ruleId: 'B-only', entry: 'siteImport' as const, observationDigest: sourceDigest({ ordinal: 1 }) }];
test('browser and server pin the same canonical digest without locale dependent ordering', () => {
  for (const v of [scope, { scope, edges, epoch: 1 }, { Z: 3, A: 2, a: 1, 'é': '文本' }]) expect(sourceDigest(v)).toBe(sourceHash(v));
  expect(parseSourceScope(scope)).toEqual(scope); expect(parseSourceEdges(edges, scope)).toEqual(edges);
});
test('source contract is closed, bounded, per-edge and canonical-identity specific', () => {
  for (const bad of [{ ...scope, nativeId: 'foreign' }, { ...scope, policy: { ...scope.policy, copies: 'singleKeepExisting' } }, { ...scope, identityVersion: 2 }]) expect(() => parseSourceScope(bad)).toThrow();
  for (const bad of [[{ ...edges[0], collectionId: '202' }], [{ ...edges[0], itemId: 'BV1' }], [{ ...edges[0], url: 'https://evil.test/' }], Array(21).fill(edges[0]), [edges[0], edges[0]], [{ ...edges[0], siteSession: 'secret' }]]) expect(() => parseSourceEdges(bad, scope)).toThrow();
});
test('old profiles and unavailable backend classification reject before command submission', async () => {
  for (const v of [null, {}, { ...SOURCE_ARCHIVE_PROFILE, sourceFinalEffects: 0 }, { ...SOURCE_ARCHIVE_PROFILE, classification: true }]) expect(() => assertSourceCloudProfile(v)).toThrow('sourceCloudUnsupported');
  const calls: string[] = [];
  const client = createSourceCloudClient({ origin: 'https://server.test', assertCurrent: async () => {}, headers: async () => ({ Authorization: 'Bearer controlled' }), fetch: (async (url, init) => { calls.push(String(init?.method)); return Response.json({ version: 0 }); }) as typeof fetch });
  await expect(client.call('commit', { layout: scope })).rejects.toThrow('sourceCloudUnsupported'); expect(calls).toEqual(['GET']);
});
test('final receipts reject root placeholders, changed commands, partial results and effect tampering', () => {
  const effects = [{ ...edges[0], nodeId: 'bookmark', finalParentId: 'source-folder', resourceRevision: 'r', operationId: 'op', disposition: 'created' }];
  const plan = { planId: 'plan', digest: sourceDigest(edges), epoch: 1, scope, edges };
  const mutations = [{ kind: 'bookmark', nodeId: 'bookmark', parentId: 'source-folder', operationId: 'op', resourceRevision: 'r', contentRevision: 'c', commitOrdinal: '1' }];
  const receipt = { mutations, mutationsDigest: sourceDigest(mutations), version: 1, planId: 'plan', digest: plan.digest, epoch: 1, collectionId: scope.collectionId, classification: 'disabled', effects, effectDigest: sourceDigest(effects) };
  expect(() => assertCloudReceipt(receipt, plan)).not.toThrow();
  for (const bad of [{ ...receipt, digest: sourceDigest('other') }, { ...receipt, effects: [] }, { ...receipt, classification: 'enabled' }, { ...receipt, effects: [{ ...effects[0], finalParentId: 'canonical-root' }], effectDigest: sourceDigest([{ ...effects[0], finalParentId: 'canonical-root' }]) }]) expect(() => assertCloudReceipt(bad, plan)).toThrow();
});
test('authority is rechecked after async header work and before a network mutation', async () => {
  let current = true, posted = false;
  const client = createSourceCloudClient({ origin: 'https://server.test', assertCurrent: async () => { if (!current) throw new Error('revoked'); }, headers: async () => { current = false; return {}; }, fetch: (async () => { posted = true; return Response.json(SOURCE_ARCHIVE_PROFILE); }) as typeof fetch });
  await expect(client.call('commit', {})).rejects.toThrow('revoked'); expect(posted).toBe(false);
});

test('a later lower-ID membership is not lost behind a completed batch cursor', () => {
  const progress = cloudProgress({}, { 'video:av:20/B': 20 });
  expect(cloudEdgeUnseen(progress, 'video:av:1/B', 21)).toBe(true);
  expect(cloudEdgeUnseen(progress, 'video:av:20/B', 20)).toBe(false);
  expect(cloudEdgeUnseen(progress, 'video:av:20/B', 22)).toBe(true);
  expect(cloudProgress(progress, { 'video:av:20/B': 19 })).toEqual(progress);
});

test('cloud namespaces preserve legacy receipts but separate equal account IDs and identity revisions', () => {
  const legacy = { site: 'bilibili', identityVersion: 1, sourceAccount: '42' };
  expect(sourceConnectionKey(legacy)).toBe('42');
  expect(new Set([sourceConnectionKey(legacy), sourceConnectionKey({ ...legacy, site: 'uninstalled-source' }), sourceConnectionKey({ ...legacy, identityVersion: 2 })]).size).toBe(3);
  expect(sourceInput({ sourceAccount: '42', expectedEpoch: 0 }, ['sourceAccount', 'expectedEpoch']).source).toEqual(legacy);
  expect(sourceInput({ ...legacy, expectedEpoch: 0 }, ['sourceAccount', 'expectedEpoch']).source).toEqual(legacy);
  expect(() => sourceInput({ ...legacy, site: 'uninstalled-source', expectedEpoch: 0 }, ['sourceAccount', 'expectedEpoch'])).toThrow('unsupported_source_scope');
  expect(() => sourceInput({ sourceAccount: '42', site: 'bilibili', expectedEpoch: 0 }, ['sourceAccount', 'expectedEpoch'])).toThrow('invalid_source_document');
});

test('a registered local identity cannot spend cloud authority without the matching server profile', async () => {
  const calls: string[] = [];
  const client = createSourceCloudClient({ identity: { site: 'bilibili', identityVersion: 2 }, origin: 'https://server.test',
    assertCurrent: async () => {}, headers: async () => ({}), fetch: (async (_url, init) => { calls.push(init?.method ?? 'GET'); return Response.json(SOURCE_ARCHIVE_PROFILE); }) as typeof fetch });
  await expect(client.call('renew', { sourceAccount: '42' })).rejects.toThrow('sourceCloudUnsupported');
  expect(calls).toEqual(['GET']);
});
