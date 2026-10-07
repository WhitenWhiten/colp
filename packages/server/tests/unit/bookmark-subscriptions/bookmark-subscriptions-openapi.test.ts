import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

interface BookmarkSubscriptionParameter {
  readonly $ref?: string;
}

interface BookmarkSubscriptionHttpResponse {
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
}

interface BookmarkSubscriptionOperation {
  readonly operationId: string;
  readonly parameters: readonly BookmarkSubscriptionParameter[];
  readonly responses: Readonly<Record<string, BookmarkSubscriptionHttpResponse>>;
}

const document = parse(readFileSync(new URL('../../../openapi/product-v1.yaml', import.meta.url), 'utf8')) as {
  readonly paths: Readonly<Record<string, Readonly<Record<string, BookmarkSubscriptionOperation>>>>;
};
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(document, 'urn:known:product');
const validator = (name: string) => ajv.compile({ $ref: 'urn:known:product#/components/schemas/BookmarkSubscription' + name });
const mapping = {
  mappingId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222',
  profileLabel: 'Work browser', mode: 'readonly', digestMode: 'recent', editionLimit: 10,
  checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'keep' },
};

describe('BS-01 frozen Product subscription contract', () => {
  test('mapping modes enforce the edition ceiling and forbid native identifiers', () => {
    const valid = validator('CreateMapping');
    for (const editionLimit of [1, 10, 20]) expect(valid({ ...mapping, editionLimit })).toBe(true);
    for (const editionLimit of [0, 21, 1.5, null]) expect(valid({ ...mapping, editionLimit })).toBe(false);
    expect(valid({ ...mapping, digestMode: 'latest', editionLimit: 20 })).toBe(false);
    expect(valid({ ...mapping, digestMode: 'latest', editionLimit: 1 })).toBe(true);
    expect(valid({ ...mapping, digestMode: null, editionLimit: null, checkIntervalMinutes: null })).toBe(true);
    expect(valid({ ...mapping, rootNativeId: 'browser-123' })).toBe(false);
    expect(valid({ ...mapping, mountParentNativeId: '1' })).toBe(false);
  });

  test('source preview and registered mapping snapshots cannot mix authority', () => {
    const valid = validator('SnapshotInput');
    const preview = { sourceType: 'digest_series', sourceId: 'digest-one', digestMode: 'recent', editionLimit: 20 };
    expect(valid(preview)).toBe(true);
    expect(valid({ ...preview, sourceType: 'collection' })).toBe(false);
    expect(valid({ ...preview, mappingId: mapping.mappingId })).toBe(false);
    expect(valid({ mappingId: mapping.mappingId, expectedProjectionEtag: '"bsp-1"' })).toBe(true);
    expect(valid({ mappingId: mapping.mappingId, expectedProjectionEtag: '*' })).toBe(false);
  });

  test('permission batches are closed, unique, bounded and have no receipt contract', () => {
    const valid = validator('NodeAccessInput');
    const node = { sourceCollectionId: 'collection-one', nodeId: 'node-one', editionId: null };
    expect(valid({ generation: 'generation-one', nodes: [node] })).toBe(true);
    expect(valid({ generation: 'generation-one', nodes: [] })).toBe(false);
    expect(valid({ generation: 'generation-one', nodes: [node, node] })).toBe(false);
    expect(valid({ generation: 'generation-one', nodes: Array.from({ length: 129 }, (_, i) => ({ ...node, nodeId: 'node-' + i })) })).toBe(false);
    expect(valid({ generation: 'generation-one', nodes: [{ ...node, title: 'private' }] })).toBe(false);
    const operation = document.paths['/api/v1/me/bookmark-subscription-mappings/{mappingId}/node-access-checks'].post;
    expect(operation.parameters.some((parameter) => parameter.$ref?.endsWith('/CommandId'))).toBe(false);
  });

  test('incomplete pages cannot claim finality and completed pages have no next cursor', () => {
    const valid = validator('NodePage');
    const page = { snapshotId: mapping.mappingId, projectionRevision: 'revision-one', items: [], nextCursor: null, complete: true };
    expect(valid(page)).toBe(true);
    expect(valid({ ...page, nextCursor: 'next' })).toBe(false);
    expect(valid({ ...page, complete: false })).toBe(false);
  });

  test('all 20 new operations bind Cookie responses and projection 304 is empty', () => {
    const operations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/api/v1/me/bookmark-subscription'))
      .flatMap(([, item]) => Object.values(item));
    expect(operations).toHaveLength(20);
    expect(new Set(operations.map(operation => operation.operationId)).size).toBe(20);
    for (const operation of operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status.startsWith('2') || status === '304') {
          expect(response.headers?.['Known-Subscription-Session']).toBeDefined();
        }
      }
    }
    const unchanged = document.paths['/api/v1/me/bookmark-subscription-mappings/{mappingId}/projection'].get.responses['304'];
    expect(unchanged.content).toBeUndefined();
  });
});
