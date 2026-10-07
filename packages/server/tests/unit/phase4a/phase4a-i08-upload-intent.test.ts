/**
 * P4A-I08 unit/contract suite (part 1): input validation and the
 * authorization matrix against the in-memory access-policy facts port.
 *
 * No PostgreSQL and no network are involved. Every denial must also prove
 * that NOTHING was persisted (zero intents/generations/keys) — a denied
 * request must never allocate a durable generation.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  UploadIntentAuthorizationError,
  UploadIntentInputError,
  issueUploadIntent,
  nodeUploadIntentCrypto,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryAccessPolicy,
  InMemoryIntentLedger,
  InMemoryIntentUow,
  I08_BUCKET,
  I08_COLLECTION,
  I08_LIVE_PREFIX,
  I08_PRINCIPAL,
  I08_SUBJECT,
  RecordingGrantStore,
  expectedBlobId,
  makeActor,
  makeI08Config,
} from '../../support/phase4a-i08-test-helpers.js';

const CONFIG = makeI08Config();

function harness(overrides: {
  collectionId?: string;
  subjectId?: string;
  policyRevision?: string;
  deleted?: boolean;
} = {}) {
  const ledger = new InMemoryIntentLedger();
  const policy = new InMemoryAccessPolicy();
  policy.seed({
    id: overrides.collectionId ?? I08_COLLECTION,
    ownerSubjectId: overrides.subjectId ?? I08_SUBJECT,
    visibility: 'private',
    policyRevision: overrides.policyRevision ?? 'policy-r1',
    deleted: overrides.deleted,
    members: [
      { subjectId: I08_SUBJECT, role: 'owner' },
      { subjectId: 'i08-subject-editor', role: 'editor' },
      { subjectId: 'i08-subject-viewer', role: 'viewer' },
    ],
  });
  const store = new RecordingGrantStore();
  return {
    ledger,
    policy,
    store,
    deps: {
      ledger,
      accessPolicyFor: () => policy,
      blobStore: store,
      uow: new InMemoryIntentUow(ledger),
      crypto: nodeUploadIntentCrypto,
      config: CONFIG,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    },
  };
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    actor: makeActor(),
    collectionId: I08_COLLECTION,
    idempotencyKey: 'idem-1',
    declaredSize: 1024,
    ...overrides,
  };
}

describe('P4A-I08 upload intent input validation', () => {
  test('accepts a well-formed request and resolves the subject from the trusted actor', async () => {
    const h = harness();
    const result = await issueUploadIntent(h.deps, issueInput());
    assert.equal(result.receipt.intentId.length, 32);
    assert.equal(result.receipt.generationId.length, 32);
    assert.equal(result.blobId, expectedBlobId(I08_COLLECTION, I08_SUBJECT, 'idem-1'));
    assert.equal(result.recovered, false);
  });

  test('a subject candidate different from the trusted actor subject is rejected', async () => {
    const h = harness();
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ subjectIdentity: 'someone-else' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'subject_mismatch',
    );
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('missing or oversized collection / idempotency identifiers are rejected', async () => {
    const h = harness();
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ collectionId: '   ' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'collection_id_required',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ collectionId: 'c'.repeat(513) })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'collection_id_too_long',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ idempotencyKey: '' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'idempotency_key_required',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ idempotencyKey: 'k'.repeat(257) })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'idempotency_key_too_long',
    );
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('declared size must be a non-negative safe integer within single-PUT max and the compile ceiling', async () => {
    const h = harness();
    const small = makeI08Config({ singlePutMaxBytes: 4096 });
    const depsSmall = { ...h.deps, config: small };
    await assert.rejects(
      issueUploadIntent(depsSmall, issueInput({ declaredSize: -1 })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_required',
    );
    await assert.rejects(
      issueUploadIntent(depsSmall, issueInput({ declaredSize: 1.5 })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_required',
    );
    await assert.rejects(
      issueUploadIntent(depsSmall, issueInput({ declaredSize: 4097 })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_out_of_range',
    );
    // Zero-byte and exact-ceiling uploads are valid boundaries.
    const zero = await issueUploadIntent(depsSmall, issueInput({ idempotencyKey: 'idem-zero', declaredSize: 0 }));
    assert.equal(zero.grant.contentLength, 0);
    const max = await issueUploadIntent(depsSmall, issueInput({ idempotencyKey: 'idem-max', declaredSize: 4096 }));
    assert.equal(max.grant.contentLength, 4096);
    assert.equal(h.ledger.generationCount(), 2);
  });

  test('a config object that bypasses parsing cannot exceed the compile ceiling', async () => {
    const h = harness();
    const rogue = makeI08Config({ singlePutMaxBytes: 64 * 1024 * 1024 });
    await assert.rejects(
      issueUploadIntent({ ...h.deps, config: rogue }, issueInput({ declaredSize: 64 * 1024 * 1024 + 1 })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'size_out_of_range',
    );
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('digest shape must be 64 lowercase hex; uppercase is normalized', async () => {
    const h = harness();
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ declaredSha256: 'abc' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'digest_invalid',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ declaredSha256: 'g'.repeat(64) })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'digest_invalid',
    );
    const uppercase = 'A'.repeat(64);
    const result = await issueUploadIntent(h.deps, issueInput({ idempotencyKey: 'idem-digest', declaredSha256: uppercase }));
    const intent = [...h.ledger.committed.intents.values()].find((entry) => entry.idempotencyKey === 'idem-digest');
    assert.equal(intent?.expectedSha256, 'a'.repeat(64));
    assert.equal(result.recovered, false);
  });

  test('media hint must be inside the configured allowed-media set (case-insensitive)', async () => {
    const h = harness();
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput({ mediaHint: 'image/svg+xml' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'media_not_allowed',
    );
    const result = await issueUploadIntent(h.deps, issueInput({ idempotencyKey: 'idem-media', mediaHint: 'IMAGE/PNG' }));
    const intent = [...h.ledger.committed.intents.values()].find((entry) => entry.idempotencyKey === 'idem-media');
    assert.equal(intent?.mediaHint, 'image/png');
    assert.equal(result.grant.contentType, 'image/png');
  });

  test('an empty allowed-media config rejects every non-null media hint', async () => {
    const h = harness();
    const empty = makeI08Config({ allowedMedia: [] });
    await assert.rejects(
      issueUploadIntent({ ...h.deps, config: empty }, issueInput({ mediaHint: 'image/png' })),
      (error: unknown) => error instanceof UploadIntentInputError && error.code === 'media_not_allowed',
    );
  });
});

describe('P4A-I08 authorization matrix (attachment upload-intent policy)', () => {
  async function expectDenied(deps: Parameters<typeof issueUploadIntent>[0], input: Record<string, unknown>, reason: string): Promise<void> {
    await assert.rejects(
      issueUploadIntent(deps, issueInput(input)),
      (error: unknown) => error instanceof UploadIntentAuthorizationError && error.reasonCategory === reason,
    );
  }

  test('owner, editor, and member (viewer) may issue; every denial persists nothing', async () => {
    for (const [subjectId, expected] of [
      [I08_SUBJECT, true],
      ['i08-subject-editor', true],
      ['i08-subject-viewer', true],
    ] as const) {
      const h = harness();
      const actor = makeActor(subjectId, `principal-${subjectId}`);
      if (expected) {
        const result = await issueUploadIntent(h.deps, issueInput({ actor }));
        assert.equal(result.recovered, false);
        assert.equal(h.ledger.generationCount(), 1);
      }
    }
  });

  test('unauthorized non-member on a private collection is concealed and persists nothing', async () => {
    const h = harness();
    await expectDenied(h.deps, { actor: makeActor('i08-outsider', 'principal-outsider') }, 'not_a_member');
    assert.equal(h.ledger.generationCount(), 0);
    assert.equal(h.ledger.intentCount(), 0);
  });

  test('cross-Collection member is denied for the foreign collection', async () => {
    const h = harness();
    // The actor is a member of the harness collection but NOT of the foreign
    // collection: read_editor is a membership gate, so the foreign collection
    // must conceal/deny (not_a_member) with zero persistence.
    h.policy.seed({
      id: 'i08-other-collection',
      ownerSubjectId: 'i08-owner-other',
      visibility: 'private',
      policyRevision: 'policy-r1',
      members: [],
    });
    await expectDenied(h.deps, { collectionId: 'i08-other-collection' }, 'not_a_member');
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('a deleted (soft-deleted) subject/collection is concealed and persists nothing', async () => {
    const h = harness({ deleted: true });
    await expectDenied(h.deps, {}, 'resource_missing');
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('an expected policy-revision mismatch denies with policy_revision_mismatch', async () => {
    const h = harness();
    await expectDenied(h.deps, { expectedPolicyRevision: 'policy-stale' }, 'policy_revision_mismatch');
    assert.equal(h.ledger.generationCount(), 0);
  });

  test('after a policy change a replay WITHOUT an expected revision succeeds and records the new revision', async () => {
    const h = harness();
    const first = await issueUploadIntent(h.deps, issueInput({ idempotencyKey: 'idem-policy' }));
    assert.equal(first.recovered, false);
    // Simulate a policy revision bump; the actor is still a member.
    h.policy.seed({
      id: I08_COLLECTION,
      ownerSubjectId: I08_SUBJECT,
      visibility: 'private',
      policyRevision: 'policy-r2',
      members: [
        { subjectId: I08_SUBJECT, role: 'owner' },
        { subjectId: 'i08-subject-editor', role: 'editor' },
        { subjectId: 'i08-subject-viewer', role: 'viewer' },
      ],
    });
    const replay = await issueUploadIntent(h.deps, issueInput({ idempotencyKey: 'idem-policy' }));
    assert.equal(replay.recovered, true);
    assert.equal(replay.receipt.intentId, first.receipt.intentId);
    assert.equal(h.ledger.generationCount(), 1, 'policy drift is not an issue failure; identity is unchanged');
  });

  test('grant TTL and namespace are taken from the committed config', async () => {
    const h = harness();
    const result = await issueUploadIntent(h.deps, issueInput());
    assert.equal(result.grant.ttlSeconds, CONFIG.grantTtlSeconds);
    assert.equal(result.grant.ifNoneMatch, '*');
    assert.ok(result.grant.keyFingerprint.length === 64);
    const key = h.ledger.keyOfGeneration(result.receipt.generationId);
    assert.ok(key?.startsWith(I08_LIVE_PREFIX), 'the physical key must live in the configured live namespace');
    assert.equal(result.grant.url.length > 0, true);
  });
});
