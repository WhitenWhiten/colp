import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { buildFanoutRecipientPageStatement } from '../../../src/infrastructure/social/index.js';

const backendRoot = resolve(import.meta.dirname, '../../..');

/** Byte-identical owner-follow page SELECT as of CF-01 (flag off / includeCollectionFollowers: false). */
const OWNER_ONLY_TEXT = `select follow.actor_profile_id
    from follows follow
    join accounts account on account.id=follow.actor_profile_id
    join profiles profile on profile.account_id=account.id
    where follow.target_profile_id=$1
      and follow.followed_at <= $2
      and account.status='active'
      and account.deleted_at is null
      and ($3::text is null or follow.actor_profile_id > $3)
    order by follow.actor_profile_id
    limit $4`;

const OWNER = 'owner-profile';
const COLLECTION = 'collection-target';
const OCCURRED_AT = new Date('2026-07-29T10:00:00.000Z');
const AFTER = 'after-recipient';

function ownerOnlyInput(overrides: {
  readonly collectionId?: string;
  readonly includeCollectionFollowers?: boolean;
  readonly afterRecipientProfileId?: string | null;
} = {}) {
  return {
    ownerProfileId: OWNER,
    occurredAt: OCCURRED_AT,
    afterRecipientProfileId: overrides.afterRecipientProfileId === undefined
      ? AFTER : overrides.afterRecipientProfileId,
    limit: 25,
    ...overrides,
  };
}

test('flag-off owner page text and $1..$4 bindings stay byte-identical', () => {
  const omitted = buildFanoutRecipientPageStatement(ownerOnlyInput());
  const explicit = buildFanoutRecipientPageStatement(ownerOnlyInput({
    includeCollectionFollowers: false, collectionId: COLLECTION,
  }));
  const values = Object.freeze([OWNER, OCCURRED_AT, AFTER, 25] as const);

  assert.equal(omitted.text, OWNER_ONLY_TEXT);
  assert.equal(explicit.text, OWNER_ONLY_TEXT);
  assert.equal(omitted.text === explicit.text, true);
  assert.deepEqual(omitted.values, values);
  assert.deepEqual(explicit.values, values);
  assert.equal(omitted.values.length, 4);
  assert.equal(explicit.values.length, 4);
  assert.equal(Object.isFrozen(omitted), true);
  assert.equal(Object.isFrozen(omitted.values), true);
});

test('includeCollectionFollowers unions collection_follows then keysets by actor_profile_id', () => {
  const statement = buildFanoutRecipientPageStatement(ownerOnlyInput({
    includeCollectionFollowers: true, collectionId: COLLECTION,
  }));
  assert.notEqual(statement.text, OWNER_ONLY_TEXT);
  assert.match(statement.text, /\bunion\b/u);
  assert.match(statement.text, /from collection_follows collection_follow/u);
  assert.match(
    statement.text,
    /collection_follow\.collection_id=\$5/u,
  );
  assert.match(
    statement.text,
    /collection_follow\.followed_at <= \$2/u,
  );
  assert.match(
    statement.text,
    /account\.status='active'/u,
  );
  assert.match(
    statement.text,
    /account\.deleted_at is null/u,
  );
  assert.match(
    statement.text,
    /collection_follow\.follower_profile_id > \$3/u,
  );
  assert.match(
    statement.text,
    /order by (?:recipients\.)?actor_profile_id/u,
  );
  assert.match(statement.text, /limit \$4/u);
  assert.deepEqual(statement.values, [OWNER, OCCURRED_AT, AFTER, 25, COLLECTION]);
});

test('UNION input still rejects invalid owner page fields and requires collectionId when enabled', () => {
  assert.throws(
    () => buildFanoutRecipientPageStatement(ownerOnlyInput({
      includeCollectionFollowers: true, collectionId: '',
    })),
    (error: unknown) => error instanceof TypeError
      && error.message === 'invalid fan-out recipient page input',
  );
  assert.throws(
    () => buildFanoutRecipientPageStatement(ownerOnlyInput({
      includeCollectionFollowers: true, collectionId: ' padded ',
    })),
    (error: unknown) => error instanceof TypeError
      && error.message === 'invalid fan-out recipient page input',
  );
  assert.throws(
    () => buildFanoutRecipientPageStatement({
      ownerProfileId: OWNER,
      occurredAt: OCCURRED_AT,
      afterRecipientProfileId: AFTER,
      limit: 25,
      includeCollectionFollowers: true,
    }),
    (error: unknown) => error instanceof TypeError
      && error.message === 'invalid fan-out recipient page input',
  );
});

test('worker assembly and evidence keep the flag-off owner page unless collectionFollow is enabled', async () => {
  const worker = await readFile(resolve(backendRoot, 'src/bootstrap/worker.ts'), 'utf8');
  const statement = await readFile(
    resolve(backendRoot, 'src/infrastructure/social/feed-fanout-recipient-statement.ts'), 'utf8',
  );
  const postgres = await readFile(
    resolve(backendRoot, 'src/infrastructure/social/feed-worker-postgres.ts'), 'utf8',
  );
  const evidence = await readFile(
    resolve(backendRoot, 'scripts/evidence/phase5-social-capacity.ts'), 'utf8',
  );

  assert.match(worker, /includeCollectionFollowers:\s*config\.collectionFollow\.enabled/u);
  assert.match(postgres, /includeCollectionFollowers/u);
  assert.match(postgres, /collectionId:\s*event\.collectionId/u);
  assert.match(evidence, /collectionId:/u);
  // Both statement builders fail closed, so the capacity evidence must opt in
  // explicitly to measure the union authority that production (flag on by
  // default) actually executes.
  assert.equal(evidence.includes('includeCollectionFollowers: true'), true);
  assert.match(statement, /KNOWN_FEATURE_COLLECTION_FOLLOW|includeCollectionFollowers/u);
});
