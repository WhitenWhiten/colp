/**
 * P4A-I08 unit/contract suite (part 2): idempotency, recovery, fault
 * injection, CSPRNG collision, receipt shape, and the "no URL/key persisted or
 * logged" invariant.
 *
 * The in-memory ledger is transaction-aware: before-commit faults leave
 * nothing persisted, while commit-success-response-lost faults leave the
 * committed row and the second attempt must recover it by re-reading the
 * database — never by guessing from the caught exception.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  AttachmentsIdentityError,
  UploadIntentExpiredError,
  UploadIntentIdentityError,
  UploadIntentInputError,
  UploadIntentSigningError,
  computeBlobIdFromBinding,
  issueUploadIntent,
  nodeUploadIntentCrypto,
  type IntentLogEntry,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryAccessPolicy,
  InMemoryIntentLedger,
  InMemoryIntentUow,
  I08_COLLECTION,
  I08_LIVE_PREFIX,
  I08_SUBJECT,
  QueueCrypto,
  RecordingGrantStore,
  expectedBlobId,
  hexFor,
  makeActor,
  makeI08Config,
  sha256Hex,
} from '../../support/phase4a-i08-test-helpers.js';

const CONFIG = makeI08Config();
const NOW = '2026-08-08T12:00:00.000Z';

function seedPolicy(ledger: { policy?: InMemoryAccessPolicy } = {}) {
  const policy = new InMemoryAccessPolicy();
  policy.seed({
    id: I08_COLLECTION,
    ownerSubjectId: I08_SUBJECT,
    visibility: 'private',
    policyRevision: 'policy-r1',
    members: [{ subjectId: I08_SUBJECT, role: 'owner' }],
  });
  return policy;
}

function onlyStoredIntent(ledger: InMemoryIntentLedger) {
  const stored = ledger.committed.intents.values().next().value;
  assert.ok(stored, 'expected exactly one committed intent');
  return stored;
}
function issueInput(idempotencyKey = 'idem-1', overrides: Record<string, unknown> = {}) {
  return {
    actor: makeActor(),
    collectionId: I08_COLLECTION,
    idempotencyKey,
    declaredSize: 1024,
    ...overrides,
  };
}

function harness(crypto: { randomHex(bytes: number): string } = nodeUploadIntentCrypto, hooks: { uow?: InstanceType<typeof InMemoryIntentUow> } = {}) {
  const ledger = new InMemoryIntentLedger();
  const policy = seedPolicy();
  const store = new RecordingGrantStore();
  const uow = hooks.uow ?? new InMemoryIntentUow(ledger);
  const deps = {
    ledger,
    accessPolicyFor: () => policy,
    blobStore: store,
    uow,
    crypto,
    config: CONFIG,
    now: () => new Date(NOW),
  };
  return { ledger, policy, store, uow, deps };
}

describe('P4A-I08 idempotency and single-identity', () => {
  test('one request binding yields one durable intent/generation', async () => {
    const h = harness();
    const result = await issueUploadIntent(h.deps, issueInput());
    assert.equal(h.ledger.intentCount(), 1);
    assert.equal(h.ledger.generationCount(), 1);
    assert.deepEqual(result.receipt, { intentId: result.receipt.intentId, generationId: result.receipt.generationId });
    assert.equal(result.recovered, false);
  });

  test('same binding replay recovers the SAME identity and re-signs a new URL', async () => {
    const h = harness();
    const first = await issueUploadIntent(h.deps, issueInput());
    const second = await issueUploadIntent(h.deps, issueInput());
    assert.equal(second.recovered, true);
    assert.equal(second.receipt.intentId, first.receipt.intentId);
    assert.equal(second.receipt.generationId, first.receipt.generationId);
    assert.equal(second.blobId, first.blobId);
    assert.equal(h.ledger.generationCount(), 1, 'recovery must not allocate a new generation');
    assert.equal(h.ledger.keyOfGeneration(first.receipt.generationId), h.ledger.keyOfGeneration(second.receipt.generationId));
    assert.notEqual(second.grant.url, first.grant.url, 'the URL signature/expiry differs but the identity is the same');
    assert.equal(h.store.grants.length, 2);
  });

  test('a different binding allocates a NEW blob, generation, and key (replacement always uses a new key)', async () => {
    const h = harness();
    const first = await issueUploadIntent(h.deps, issueInput('idem-1'));
    const second = await issueUploadIntent(h.deps, issueInput('idem-2'));
    assert.equal(second.recovered, false);
    assert.notEqual(second.receipt.intentId, first.receipt.intentId);
    assert.notEqual(second.receipt.generationId, first.receipt.generationId);
    assert.notEqual(second.blobId, first.blobId);
    assert.equal(h.ledger.generationCount(), 2);
    const key1 = h.ledger.keyOfGeneration(first.receipt.generationId);
    const key2 = h.ledger.keyOfGeneration(second.receipt.generationId);
    assert.notEqual(key1, key2, 'every new attempt must use a new physical key');
    assert.notEqual(sha256Hex(key1!), sha256Hex(key2!));
  });

  test('same binding with different declared facts is a non-rebindable identity conflict', async () => {
    const h = harness();
    await issueUploadIntent(h.deps, issueInput('idem-1', { declaredSize: 1024 }));
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput('idem-1', { declaredSize: 2048 })),
      (error: unknown) => error instanceof UploadIntentIdentityError && error.code === 'request_facts_mismatch',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput('idem-1', { declaredSha256: 'b'.repeat(64) })),
      (error: unknown) => error instanceof UploadIntentIdentityError && error.code === 'request_facts_mismatch',
    );
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput('idem-1', { mediaHint: 'application/pdf' })),
      (error: unknown) => error instanceof UploadIntentIdentityError && error.code === 'request_facts_mismatch',
    );
    assert.equal(h.ledger.generationCount(), 1, 'the committed binding must never be rebound');
  });

  test('an expired unexpired-window intent cannot be re-signed', async () => {
    const h = harness();
    await issueUploadIntent(h.deps, issueInput('idem-expiry'));
    const lateDeps = { ...h.deps, now: () => new Date(Date.parse(NOW) + 25 * 3_600_000) };
    await assert.rejects(
      issueUploadIntent(lateDeps, issueInput('idem-expiry')),
      (error: unknown) => error instanceof UploadIntentExpiredError,
    );
    assert.equal(h.ledger.generationCount(), 1);
    assert.equal(h.store.grants.length, 1, 'an expired binding must never be re-signed');
  });

  test('revocation-after-grant: a replay after membership removal is denied; the issued grant is not revoked here', async () => {
    const h = harness();
    // Use a revocable member (not the owner): the access-policy contract
    // resolves the owner subject to owner regardless of membership rows, so
    // removing a non-owner member's membership is the real revocation path.
    const memberActor = makeActor('i08-subject-editor', 'i08-principal-editor');
    h.policy.seed({
      id: I08_COLLECTION,
      ownerSubjectId: 'i08-owner-other',
      visibility: 'private',
      policyRevision: 'policy-r1',
      members: [{ subjectId: 'i08-subject-editor', role: 'editor' }],
    });
    const first = await issueUploadIntent(h.deps, issueInput('idem-revoke', { actor: memberActor }));
    assert.equal(h.store.grants.length, 1);
    h.policy.removeMember(I08_COLLECTION, 'i08-subject-editor');
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput('idem-revoke', { actor: memberActor })),
      (error: unknown) => error instanceof Error && error.name === 'UploadIntentAuthorizationError',
    );
    // The previously issued grant is untouched by the issue use case (later
    // current-authorization, I10, owns revocation); identity rows are intact.
    assert.equal(h.ledger.generationCount(), 1);
    assert.equal(h.ledger.intentCount(), 1);
    assert.equal(h.store.grants.length, 1);
  });
});

describe('P4A-I08 recovery after unknown outcomes (database re-read, never guess)', () => {
  test('before-commit failure persists nothing and the retry allocates exactly one identity', async () => {
    const h = harness();
    let beforeCommitThrew = true;
    const faultUow = new InMemoryIntentUow(h.ledger, {
      beforeCommit: async () => {
        if (beforeCommitThrew) {
          beforeCommitThrew = false;
          throw new Error('simulated crash before commit');
        }
      },
    });
    const result = await issueUploadIntent({ ...h.deps, uow: faultUow }, issueInput('idem-before-commit'));
    assert.equal(h.ledger.generationCount(), 1, 'only the retried allocation may persist');
    assert.equal(h.ledger.intentCount(), 1);
    assert.equal(result.recovered, false);
  });

  test('commit-success-response-lost recovers the SAME committed identity by re-reading the database', async () => {
    const h = harness();
    let responseLost = true;
    const faultUow = new InMemoryIntentUow(h.ledger, {
      afterCommitAcknowledged: async () => {
        if (responseLost) {
          responseLost = false;
          throw new Error('commit ack lost');
        }
      },
    });
    const result = await issueUploadIntent({ ...h.deps, uow: faultUow }, issueInput('idem-response-lost'));
    assert.equal(result.recovered, true, 'the retry must discover the already-committed intent');
    assert.equal(h.ledger.generationCount(), 1, 'response loss must never duplicate the generation');
    assert.equal(h.ledger.intentCount(), 1);
    // The committed identity equals the recovered receipt identity.
    const stored = onlyStoredIntent(h.ledger);
    assert.equal(stored.intentId, result.receipt.intentId);
    assert.equal(stored.generationId, result.receipt.generationId);
  });

  test('an idempotency race loser recovers the winner identity (one winner, one durable intent)', async () => {
    // Seed a committed intent for the binding, then run the use case through a
    // ledger whose FIRST binding lookup misses (simulating the loser's
    // look-up-before-commit race). The allocate must be rejected by the
    // committed (blob_id, idempotency_key) unique and the retry must recover.
    const h = harness();
    const seed = await issueUploadIntent(h.deps, issueInput('idem-race'));
    let missNext = true;
    const racingLedger = Object.create(h.ledger) as InMemoryIntentLedger;
    racingLedger.findIntentByBinding = async (tx: number, input: { collectionId: string; subjectIdentity: string; idempotencyKey: string }) => {
      if (missNext) {
        missNext = false;
        return { outcome: 'not_found' };
      }
      return (h.ledger as InMemoryIntentLedger).findIntentByBinding(tx, input);
    };
    const result = await issueUploadIntent({ ...h.deps, ledger: racingLedger }, issueInput('idem-race'));
    assert.equal(result.recovered, true);
    assert.equal(result.receipt.intentId, seed.receipt.intentId);
    assert.equal(result.receipt.generationId, seed.receipt.generationId);
    assert.equal(h.ledger.generationCount(), 1);
    assert.equal(h.ledger.intentCount(), 1);
  });

  test('signing failure must not delete the generation or reuse the key; a later call re-signs the same identity', async () => {
    const h = harness();
    h.store.failNextWith = new Error('signer boom');
    await assert.rejects(
      issueUploadIntent(h.deps, issueInput('idem-sign')),
      (error: unknown) => error instanceof UploadIntentSigningError,
    );
    assert.equal(h.ledger.generationCount(), 1, 'the committed generation survives the signing failure');
    assert.equal(h.ledger.intentCount(), 1);
    const stored = onlyStoredIntent(h.ledger);
    const keyAfterFailure = h.ledger.keyOfGeneration(stored.generationId);
    assert.ok(keyAfterFailure, 'the key must remain bound and reusable for the SAME unexpired binding');

    const retry = await issueUploadIntent(h.deps, issueInput('idem-sign'));
    assert.equal(retry.recovered, true);
    assert.equal(retry.receipt.intentId, stored.intentId);
    assert.equal(retry.receipt.generationId, stored.generationId);
    assert.equal(h.ledger.generationCount(), 1, 're-signing must not allocate a new generation');
    assert.equal(h.ledger.keyOfGeneration(stored.generationId), keyAfterFailure, 'the same key is re-signed for the same binding');
    assert.equal(h.store.grants.length, 1, 'only the recovery call signs a fresh URL');
  });
});

describe('P4A-I08 CSPRNG collision (controlled injection)', () => {
  test('a duplicate key candidate is rejected by the ledger and a fresh candidate is allocated, never overwriting', async () => {
    const h = harness();
    // The use case namespaces every physical key with the configured live
    // prefix; the injected CSPRNG value is the random suffix. First binding
    // commits key K1 with deterministic crypto.
    const k1 = hexFor('key-1');
    const firstCrypto = new QueueCrypto([hexFor('intent-1'), hexFor('gen-1'), k1]);
    const first = await issueUploadIntent({ ...h.deps, crypto: firstCrypto }, issueInput('idem-collision-a'));
    assert.equal(h.ledger.keyOfGeneration(first.receipt.generationId), I08_LIVE_PREFIX + k1);

    // Second binding's first attempt reuses K1 (injected duplicate): the
    // database must reject (key_issued) and the use case must retry with a
    // fresh candidate. Never overwrite the existing row.
    const k2 = hexFor('key-2');
    const collisionCrypto = new QueueCrypto([
      hexFor('intent-2a'), hexFor('gen-2a'), k1, // attempt 0: colliding key
      hexFor('intent-2b'), hexFor('gen-2b'), k2, // attempt 1: fresh candidate
    ]);
    const second = await issueUploadIntent({ ...h.deps, crypto: collisionCrypto }, issueInput('idem-collision-b'));
    assert.equal(second.recovered, false);
    assert.equal(h.ledger.keyOfGeneration(second.receipt.generationId), I08_LIVE_PREFIX + k2);
    assert.equal(h.ledger.generationCount(), 2);
    assert.equal(h.ledger.keyOfGeneration(first.receipt.generationId), I08_LIVE_PREFIX + k1, 'the colliding key row must never be overwritten');
    assert.equal(h.ledger.allKeys().filter((key) => key === I08_LIVE_PREFIX + k1).length, 1);
    assert.equal(collisionCrypto.calls, 6);
  });

  test('a duplicate generation candidate is rejected and retried with a fresh identity', async () => {
    const h = harness();
    const gen1 = hexFor('gen-1');
    const first = await issueUploadIntent({ ...h.deps, crypto: new QueueCrypto([hexFor('intent-1'), gen1, hexFor('key-1')]) }, issueInput('idem-gen-collision-a'));
    assert.equal(first.receipt.generationId, gen1);
    const collisionCrypto = new QueueCrypto([
      hexFor('intent-2a'), gen1, hexFor('key-2a'),
      hexFor('intent-2b'), hexFor('gen-2b'), hexFor('key-2b'),
    ]);
    const second = await issueUploadIntent({ ...h.deps, crypto: collisionCrypto }, issueInput('idem-gen-collision-b'));
    assert.equal(second.receipt.generationId, hexFor('gen-2b'));
    assert.equal(h.ledger.generationCount(), 2);
    assert.equal(h.ledger.committed.generations.get(gen1)?.blobId, first.blobId, 'the first generation identity is untouched');
  });

  test('a persistent collision beyond the bounded retry surfaces as an identity error', async () => {
    const h = harness();
    await issueUploadIntent(h.deps, issueInput('idem-persist-a'));
    const k1 = h.ledger.allKeys()[0]!;
    // Injected CSPRNG values are the random suffix; the use case re-applies
    // the live prefix, so collide on the suffix of the committed key.
    const k1Suffix = k1.slice(I08_LIVE_PREFIX.length);
    // Both attempts collide on the same key: the use case retries once and then fails.
    const stuck = new QueueCrypto([hexFor('intent-x'), hexFor('gen-x'), k1Suffix, hexFor('intent-y'), hexFor('gen-y'), k1Suffix]);
    await assert.rejects(
      issueUploadIntent({ ...h.deps, crypto: stuck }, issueInput('idem-persist-b')),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
    assert.equal(h.ledger.generationCount(), 1, 'failed attempts must not persist anything');
  });
});

describe('P4A-I08 receipt shape and no URL/key persistence or logging', () => {
  test('the opaque receipt is exactly { intentId, generationId } and the grant is memory-only', async () => {
    const h = harness();
    const result = await issueUploadIntent(h.deps, issueInput());
    assert.deepEqual(result.receipt, { intentId: result.receipt.intentId, generationId: result.receipt.generationId });
    assert.equal(result.grant.method, 'PUT');
    assert.equal(result.grant.ifNoneMatch, '*');
    assert.equal(result.grant.generationId, result.receipt.generationId);
    assert.equal(result.grant.contentLength, 1024);
    // The grant URL is only on the response object: never in the ledger.
    const stored = onlyStoredIntent(h.ledger);
    assert.equal(stored.key.startsWith('attachments/live/'), true);
    assert.equal(JSON.stringify(stored).includes(result.grant.url), false);
  });

  test('logs record only fixed result classes and never URLs, keys, fingerprints, or digests', async () => {
    const h = harness();
    const entries: IntentLogEntry[] = [];
    const deps = { ...h.deps, log: (entry: IntentLogEntry) => entries.push(entry) };
    await issueUploadIntent(deps, issueInput('idem-log'));
    await issueUploadIntent(deps, issueInput('idem-log')); // recovery
    const classes = new Set(entries.map((entry) => entry.class));
    assert.ok(classes.has('intent_issued'));
    assert.ok(classes.has('intent_recovered'));
    assert.ok(classes.has('grant_signed'));
    const serialized = JSON.stringify(entries);
    const storedKey = h.ledger.keyOfGeneration(onlyStoredIntent(h.ledger).generationId);
    assert.ok(storedKey, 'expected a committed key');
    for (const forbidden of [storedKey, 'attachments/live/', 'https://', 'X-Amz-', 'sha256', 'idem-log']) {
      assert.equal(serialized.includes(forbidden), false, `log leaked ${forbidden}`);
    }
  });

  test('a denied request is logged as intent_denied with no identity fields', async () => {
    const h = harness();
    // Use a revocable member (not the owner) so the removal actually revokes.
    const memberActor = makeActor('i08-subject-editor', 'i08-principal-editor');
    h.policy.seed({
      id: I08_COLLECTION,
      ownerSubjectId: 'i08-owner-other',
      visibility: 'private',
      policyRevision: 'policy-r1',
      members: [{ subjectId: 'i08-subject-editor', role: 'editor' }],
    });
    const entries: IntentLogEntry[] = [];
    h.policy.removeMember(I08_COLLECTION, 'i08-subject-editor');
    await assert.rejects(
      issueUploadIntent({ ...h.deps, log: (entry: IntentLogEntry) => entries.push(entry) }, issueInput('idem-denied', { actor: memberActor })),
      (error: unknown) => error instanceof Error && error.name === 'UploadIntentAuthorizationError',
    );
    assert.deepEqual(entries.map((entry) => entry.class), ['intent_denied']);
    assert.equal(JSON.stringify(entries).includes(I08_COLLECTION), false);
  });

  test('invalid input logs intent_invalid before any database work', async () => {
    const h = harness();
    const entries: IntentLogEntry[] = [];
    await assert.rejects(
      issueUploadIntent({ ...h.deps, log: (entry: IntentLogEntry) => entries.push(entry) }, issueInput('idem-invalid', { declaredSize: -3 })),
      (error: unknown) => error instanceof UploadIntentInputError,
    );
    assert.equal(h.ledger.generationCount(), 0);
    assert.deepEqual(entries.map((entry) => entry.class), ['intent_invalid']);
  });

  test('the deterministic blob id is stable and namespaced', () => {
    const a = computeBlobIdFromBinding(I08_COLLECTION, I08_SUBJECT, 'idem-1');
    const b = computeBlobIdFromBinding(I08_COLLECTION, I08_SUBJECT, 'idem-1');
    const c = computeBlobIdFromBinding(I08_COLLECTION, I08_SUBJECT, 'idem-2');
    const d = computeBlobIdFromBinding('other-collection', I08_SUBJECT, 'idem-1');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
    assert.equal(a, expectedBlobId(I08_COLLECTION, I08_SUBJECT, 'idem-1'));
  });
});

