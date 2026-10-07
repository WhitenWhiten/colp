import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assertClosedJsonObject } from '../../../src/modules/collections/index.js';
import {
  SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
  SOCIAL_COLLECTION_CHANGE_EVENT_VERSION,
  SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
  mapSocialCollectionChange,
  mapSocialCollectionChangeEnvelope,
} from '../../../src/infrastructure/outbox/social-collection-change.js';

const COLLECTION_ID = 'FBQUFBQUFBQUFBQUFBQUFA';
const OWNER_PROFILE_ID = 'IiIiIiIiIiIiIiIiIiIiIg';

function map(overrides: Partial<Parameters<typeof mapSocialCollectionChange>[0]> = {}) {
  return mapSocialCollectionChange({
    collectionId: COLLECTION_ID,
    ownerProfileId: OWNER_PROFILE_ID,
    contentRevision: 'content-12',
    policyRevision: 'policy-7',
    commitOrdinal: 103n,
    visibility: 'public',
    publicationSlug: 'public-collection',
    publishedAt: new Date('2026-07-28T12:02:00.000Z'),
    deletedAt: null,
    ...overrides,
  });
}

describe('P5-09 social Collection change mapper', () => {
  test('maps an eligible Publication to the exact closed @2 route and payload', () => {
    const routed = map();
    assert.deepEqual(routed, {
      eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
      eventVersion: SOCIAL_COLLECTION_CHANGE_EVENT_VERSION,
      handlerName: SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
      handlerMode: SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
      aggregateType: 'collection',
      aggregateId: COLLECTION_ID,
      aggregateScope: COLLECTION_ID,
      aggregateRevision: 'content-12.policy-7',
      commitOrdinal: 103n,
      payload: {
        collectionId: COLLECTION_ID,
        ownerProfileId: OWNER_PROFILE_ID,
        publicationRevision: 'content-12.policy-7',
        discoverabilityRecheckKey: `publication.collection:${COLLECTION_ID}`,
        producerDiscoverability: 'public_candidate',
      },
    });
    assert.deepEqual(Object.keys(routed.payload).sort(), [
      'collectionId', 'discoverabilityRecheckKey', 'ownerProfileId',
      'producerDiscoverability', 'publicationRevision',
    ]);
    assert.equal(Array.isArray(routed), false);
    assert.equal(routed.handlerName, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME);
    assert.equal(routed.handlerMode, SOCIAL_COLLECTION_CHANGE_HANDLER_MODE);
  });

  test('binds the stable domain event to the exact versioned Outbox envelope', () => {
    const eventId = 'FRUVFRUVFRUVFRUVFRUVFQ';
    const occurredAt = new Date('2026-07-28T12:02:00.000Z');
    const envelope = mapSocialCollectionChangeEnvelope(eventId, occurredAt, map());
    assert.deepEqual(envelope, {
      event_id: eventId,
      event_type: 'social.collection-change',
      event_version: 2,
      aggregate_identity: {
        aggregate_type: 'collection',
        aggregate_id: COLLECTION_ID,
        aggregate_scope: COLLECTION_ID,
      },
      aggregate_revision: 'content-12.policy-7',
      commit_ordinal: '103',
      occurred_at: occurredAt.toISOString(),
      payload: map().payload,
    });
    assert.match(envelope.event_id, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
    assert.match(envelope.payload.collectionId as string, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  });

  test.each([
    ['unlisted', { visibility: 'unlisted' as const }],
    ['protected', { visibility: 'protected' as const }],
    ['private', { visibility: 'private' as const }],
    ['deleted', { deletedAt: new Date('2026-07-28T12:03:00.000Z') }],
    ['unpublished', { publishedAt: null }],
    ['missing publication locator', { publicationSlug: null }],
  ])('collapses %s to the non-disclosing remove fact', (_case, facts) => {
    const routed = map(facts);
    assert.equal(routed.payload.producerDiscoverability, 'remove');
    const serialized = JSON.stringify(routed.payload);
    for (const forbidden of ['unlisted', 'protected', 'private', 'deleted']) {
      assert.ok(!serialized.includes(`\"${forbidden}\"`));
    }
  });

  test('never copies content, mutable identity, policy or secret-bearing facts', () => {
    const marker = 'P5_09_SECRET_MARKER';
    const routed = map();
    const serialized = JSON.stringify(routed.payload);
    for (const forbidden of [
      marker, 'title', 'summary', 'body', 'handle', 'email', 'membership', 'policyRevision',
      'policyFacts',
      'cookie', 'token', 'credential', 'secret',
    ]) {
      assert.ok(!serialized.toLocaleLowerCase('und').includes(forbidden.toLocaleLowerCase('und')));
    }
    assert.ok(Buffer.byteLength(JSON.stringify(routed.payload), 'utf8') <= 2_048);
  });

  test('rejects invalid identity, revision and ordering facts before an Outbox append', () => {
    for (const overrides of [
      { collectionId: '' },
      { collectionId: '018f0e3d-c900-7900-8900-000000000000' },
      { collectionId: 'FBQUFBQUFBQUFBQUFBQUFB' },
      { collectionId: 'FBQUFBQUFBQUFBQUFBQUF' },
      { ownerProfileId: '' },
      { ownerProfileId: '018f0e3d-c900-7900-8900-000000000000' },
      { contentRevision: '' },
      { policyRevision: '' },
      { commitOrdinal: 0n },
      { commitOrdinal: -1n },
    ]) {
      assert.throws(() => map(overrides), /social collection change/u);
    }
  });

  test('rejects non-canonical originating domain event identities', () => {
    const occurredAt = new Date('2026-07-28T12:02:00.000Z');
    for (const eventId of [
      '',
      '018f0e3d-9000-7000-8000-000000000000',
      'FRUVFRUVFRUVFRUVFRUVFR',
      'FRUVFRUVFRUVFRUVFRUVF',
    ]) {
      assert.throws(
        () => mapSocialCollectionChangeEnvelope(eventId, occurredAt, map()),
        /social collection change/u,
      );
    }
  });

  test('envelope payload is admitted by the shared closed JSON guard', () => {
    const envelope = mapSocialCollectionChangeEnvelope('FRUVFRUVFRUVFRUVFRUVFQ',
      new Date('2026-07-28T12:02:00.000Z'), map());
    assertClosedJsonObject(envelope.payload);
    assert.equal(Object.isFrozen(envelope.payload), true);
  });
});
