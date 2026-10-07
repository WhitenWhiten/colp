import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createProductCommunityClient,
  type CommunityTarget,
  type CommunityVoteState,
} from '../../../generated/openapi/product-v1.client.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { COMMUNITY_VOTE_COMMAND_SCOPE } from '../../../src/modules/community/index.js';
import type { PostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createCommentHttpFixture,
  isProductClientError,
} from './comment-http-helpers.js';

/**
 * CS-01 concurrency evidence (plan §119 "并发切票" + §149 "并发与超时"):
 * real `Promise.all` HTTP vote races against the real Postgres unit of work.
 * The target authority row's FOR UPDATE lock serializes every command, so
 * after the burst there is exactly one terminal state — at most one vote row
 * per (account, target), one completed receipt per accepted command, and an
 * audit trail whose previousValue chain replays the serialization order.
 * Rejected commands roll back claim+audit+vote together: no half state.
 *
 * The last test is the §38 canonical rule: vote/comment/edit/curation writes
 * are durable in community tables but never move the target node's canonical
 * revision or updated_at.
 */
type CommunityClient = ReturnType<typeof createProductCommunityClient>;
type VoteValue = -1 | 0 | 1;

interface VoteAttempt {
  readonly ok: boolean;
  readonly state?: CommunityVoteState;
  readonly error?: unknown;
}

interface VoteAuditDetails {
  readonly targetKind: string;
  readonly targetId: string;
  readonly targetGeneration: string;
  readonly previousValue: number;
  readonly value: number;
  readonly changed: boolean;
}

interface VoteReceiptRow {
  readonly command_id: string;
  readonly result_status: number | null;
  readonly completed_at: Date | null;
  readonly has_result: boolean;
}

async function attemptVote(
  client: CommunityClient,
  target: CommunityTarget,
  value: VoteValue,
  commandId: string,
): Promise<VoteAttempt> {
  try {
    return { ok: true, state: await client.setVote({ target, value }, commandId) };
  } catch (error) {
    return { ok: false, error };
  }
}

function session(factory: PostgresBetterAuthTestFactory, role: string) {
  return issueTestSession({ factory,
    subject: `vcon-${role}-${randomUUID()}`,
    handle: `vc${randomUUID().replaceAll('-', '').slice(0, 12)}` });
}

function id12(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

describeWithPostgres('CS-01 community vote HTTP concurrency', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_vote_race', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const { testConfig, startApp, seedCollection, seedBookmark } =
    createCommentHttpFixture(() => isolated);

  async function voteRows(
    accountId: string,
    kind: string,
    targetId: string,
  ): Promise<ReadonlyArray<{ value: number; target_generation: string }>> {
    const result = await isolated.runtime.pool.query<{
      value: number; target_generation: string;
    }>(
      `select value, target_generation from community_votes
       where account_id=$1 and target_kind=$2 and target_id=$3`,
      [accountId, kind, targetId]);
    return result.rows;
  }

  /** Audit rows in insert order — the serialization witness for locked commands. */
  async function voteAudits(accountId: string, targetId: string): Promise<VoteAuditDetails[]> {
    const result = await isolated.runtime.pool.query<{ details_json: VoteAuditDetails }>(
      `select payload.details_json from audit_events event
       join audit_event_payloads payload on payload.event_id = event.id
       where event.principal_id=$1 and event.event_type='community.vote_set'
         and payload.details_json->>'targetId'=$2
       order by event.id`,
      [accountId, targetId]);
    return result.rows.map((row) => row.details_json);
  }

  async function voteReceipts(accountId: string): Promise<readonly VoteReceiptRow[]> {
    const result = await isolated.runtime.pool.query<VoteReceiptRow>(
      `select command_id, result_status, completed_at, (result_bytes is not null) as has_result
       from product_command_receipts
       where principal_id=$1 and command_scope=$2`,
      [accountId, COMMUNITY_VOTE_COMMAND_SCOPE]);
    return result.rows;
  }

  async function refreshOutboxCount(): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from outbox_events
       where handler_name='community.hot-ranking-refresh'
         and event_type='community.rank-refresh'`);
    return Number(result.rows[0]?.n ?? '0');
  }

  /** The audit chain must replay a valid serialization: 0 → … → terminal value. */
  function assertAuditChain(audits: readonly VoteAuditDetails[], terminalValue: number): void {
    let expectedPrevious = 0;
    for (const audit of audits) {
      assert.equal(audit.previousValue, expectedPrevious,
        'each committed command must observe the previous terminal value');
      assert.equal(audit.changed, audit.previousValue !== audit.value);
      expectedPrevious = audit.value;
    }
    assert.equal(expectedPrevious, terminalValue,
      'the audit chain must end at the durable terminal value');
  }

  test('same-account concurrent vote switching serializes into exactly one terminal state', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner');
      const voter = await session(factory, 'switcher');
      const collectionId = `vcon-switch-${id12()}`;
      const nodeId = `vcon-switch-node-${id12()}`;
      const rootId = await seedCollection(collectionId, owner.subjectId, 'public',
        `vcon-switch-${randomUUID().slice(0, 8)}`);
      await seedBookmark(nodeId, collectionId, rootId);

      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const target = (await client.resolveTarget(
        { kind: 'bookmark', id: nodeId, collectionId })).target;
      assert.match(target.generation, /^bm-gen-/u);

      const outboxBefore = await refreshOutboxCount();
      // Six contradictory commands from one account plus one doomed
      // stale-generation command in the same flight — all distinct ids.
      const issued = [1, -1, 1, -1, 1, -1] as const;
      const commandIds = issued.map(() => randomUUID());
      const doomedCommandId = randomUUID();
      const staleTarget: CommunityTarget = { kind: 'bookmark', id: nodeId,
        collectionId, seriesId: null, generation: 'bm-gen-stale0' };
      const settled = await Promise.all([
        ...issued.map((value, index) => attemptVote(client, target, value, commandIds[index]!)),
        attemptVote(client, staleTarget, 1, doomedCommandId),
      ]);

      const doomed = settled[issued.length]!;
      assert.ok(!doomed.ok, 'the stale-generation vote must be rejected');
      assert.ok(isProductClientError(doomed.error, 409, 'revision_conflict'));
      for (const [index, outcome] of settled.slice(0, issued.length).entries()) {
        assert.ok(outcome.ok, `concurrent vote ${index} must succeed`);
        assert.equal(outcome.state!.myVote, issued[index]);
        assert.equal(outcome.state!.target.generation, target.generation);
      }

      // Exactly one terminal state survives the serialization: a single vote
      // row whose value is one of the issued commands' values.
      const rows = await voteRows(voter.accountId, 'bookmark', nodeId);
      assert.equal(rows.length, 1);
      const finalValue = rows[0]!.value;
      assert.ok((issued as readonly number[]).includes(finalValue));
      assert.equal(rows[0]!.target_generation, target.generation);

      // In insert order each audit event's previousValue equals the value the
      // prior committed command left; the chain ends at the durable row.
      const audits = await voteAudits(voter.accountId, nodeId);
      assert.equal(audits.length, issued.length);
      for (const audit of audits) {
        assert.equal(audit.targetKind, 'bookmark');
        assert.equal(audit.targetGeneration, target.generation);
      }
      assertAuditChain(audits, finalValue);

      // Every accepted command owns exactly one completed receipt with a
      // stored 200 body. Refresh events enqueue only for real mutations:
      // commands that serialized into a no-op (same effective value the
      // lock winner left) mutated nothing and never force a rebuild.
      const receipts = await voteReceipts(voter.accountId);
      assert.deepEqual(receipts.map((row) => row.command_id).sort(), [...commandIds].sort());
      for (const receipt of receipts) {
        assert.equal(receipt.result_status, 200);
        assert.ok(receipt.completed_at !== null);
        assert.equal(receipt.has_result, true);
      }
      const mutations = audits.filter((audit) => audit.changed).length;
      assert.ok(mutations >= 1, 'at least one command must have mutated the vote');
      assert.equal(await refreshOutboxCount() - outboxBefore, mutations);

      // The rejected pre-commit failure left no half state: no receipt row,
      // and the vote/audit counts above already exclude it.
      const doomedReceipts = await isolated.runtime.pool.query<{ n: string }>(
        `select count(*)::text as n from product_command_receipts
         where principal_id=$1 and command_id=$2`,
        [voter.accountId, doomedCommandId]);
      assert.equal(doomedReceipts.rows[0]?.n, '0');

      // The public read agrees with the durable terminal state.
      const view = await client.resolveTarget({ kind: 'bookmark', id: nodeId, collectionId });
      assert.equal(view.votes.myVote, finalValue);
      assert.equal(view.votes.up, finalValue === 1 ? 1 : 0);
      assert.equal(view.votes.down, finalValue === -1 ? 1 : 0);

      // An exact same-id retry still replays the stored outcome.
      const replay = await client.setVote({ target, value: issued[0] }, commandIds[0]!);
      assert.deepEqual(replay, settled[0]!.state);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('two accounts racing opposite votes serialize on the target row lock', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner2');
      const upVoter = await session(factory, 'up');
      const downVoter = await session(factory, 'down');
      const collectionId = `vcon-pair-${id12()}`;
      await seedCollection(collectionId, owner.subjectId, 'public',
        `vcon-pair-${randomUUID().slice(0, 8)}`);

      const upClient = createProductCommunityClient({ origin, sessionCookie: upVoter.cookie,
        originHeader: config.productOrigin, csrfToken: upVoter.csrfToken });
      const downClient = createProductCommunityClient({ origin, sessionCookie: downVoter.cookie,
        originHeader: config.productOrigin, csrfToken: downVoter.csrfToken });
      const ownerClient = createProductCommunityClient({ origin, sessionCookie: owner.cookie,
        originHeader: config.productOrigin, csrfToken: owner.csrfToken });
      const target = (await upClient.resolveTarget(
        { kind: 'collection', id: collectionId })).target;

      // Two opposite votes plus a doomed self-vote in the same flight.
      const doomedCommandId = randomUUID();
      const [upOutcome, downOutcome, selfOutcome] = await Promise.all([
        attemptVote(upClient, target, 1, randomUUID()),
        attemptVote(downClient, target, -1, randomUUID()),
        attemptVote(ownerClient, target, 1, doomedCommandId),
      ]);
      assert.ok(upOutcome.ok, 'the upvote must succeed');
      assert.equal(upOutcome.state!.myVote, 1);
      assert.ok(downOutcome.ok, 'the downvote must succeed');
      assert.equal(downOutcome.state!.myVote, -1);
      assert.ok(!selfOutcome.ok, 'the self-vote must be refused');
      assert.ok(isProductClientError(selfOutcome.error, 403, 'insufficient_permission'));

      // Each command computed its counts while holding the target lock: the
      // first committer observed only its own vote, the second saw both.
      const states = [upOutcome.state!, downOutcome.state!];
      const singles = states.filter((state) => state.up + state.down === 1);
      const doubles = states.filter((state) => state.up + state.down === 2);
      assert.equal(singles.length, 1);
      assert.equal(doubles.length, 1);
      assert.deepEqual({ up: doubles[0]!.up, down: doubles[0]!.down }, { up: 1, down: 1 });
      assert.deepEqual({ up: singles[0]!.up, down: singles[0]!.down },
        singles[0] === upOutcome.state ? { up: 1, down: 0 } : { up: 0, down: 1 });

      // The durable result is exactly two vote rows reconciling with reads.
      assert.deepEqual(
        (await voteRows(upVoter.accountId, 'collection', collectionId)).map((row) => row.value),
        [1]);
      assert.deepEqual(
        (await voteRows(downVoter.accountId, 'collection', collectionId)).map((row) => row.value),
        [-1]);
      const view = await upClient.resolveTarget({ kind: 'collection', id: collectionId });
      assert.equal(view.votes.up, 1);
      assert.equal(view.votes.down, 1);
      assert.equal(view.votes.myVote, 1);

      // One audit per accepted command; independent accounts both start at 0.
      const upAudits = await voteAudits(upVoter.accountId, collectionId);
      const downAudits = await voteAudits(downVoter.accountId, collectionId);
      assert.equal(upAudits.length, 1);
      assert.equal(upAudits[0]!.previousValue, 0);
      assert.equal(upAudits[0]!.value, 1);
      assert.equal(downAudits.length, 1);
      assert.equal(downAudits[0]!.previousValue, 0);
      assert.equal(downAudits[0]!.value, -1);

      // The refused self-vote rolled back claim+audit+vote: no half state.
      assert.equal((await voteReceipts(owner.accountId)).length, 0);
      assert.equal((await voteAudits(owner.accountId, collectionId)).length, 0);
      assert.equal((await voteRows(owner.accountId, 'collection', collectionId)).length, 0);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a racing vote and cancel settle into exactly one consistent terminal state', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner3');
      const voter = await session(factory, 'racer');
      const collectionId = `vcon-race-${id12()}`;
      await seedCollection(collectionId, owner.subjectId, 'public',
        `vcon-race-${randomUUID().slice(0, 8)}`);

      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const target = (await client.resolveTarget(
        { kind: 'collection', id: collectionId })).target;

      // One account votes and un-votes in the same flight; either order is a
      // legal serialization, but the result must be one consistent terminal.
      const voteCommandId = randomUUID();
      const cancelCommandId = randomUUID();
      const [voteOutcome, cancelOutcome] = await Promise.all([
        attemptVote(client, target, 1, voteCommandId),
        attemptVote(client, target, 0, cancelCommandId),
      ]);
      assert.ok(voteOutcome.ok, 'the racing vote must succeed');
      assert.equal(voteOutcome.state!.myVote, 1);
      assert.ok(cancelOutcome.ok, 'the racing cancel must succeed');
      assert.equal(cancelOutcome.state!.myVote, 0);

      const rows = await voteRows(voter.accountId, 'collection', collectionId);
      const view = await client.resolveTarget({ kind: 'collection', id: collectionId });
      if (rows.length === 1) {
        // Serialized as cancel-then-vote: the vote row survives.
        assert.equal(rows[0]!.value, 1);
        assert.equal(view.votes.myVote, 1);
        assert.equal(view.votes.up, 1);
        assert.equal(view.votes.down, 0);
      } else {
        // Serialized as vote-then-cancel: nothing remains.
        assert.equal(rows.length, 0);
        assert.equal(view.votes.myVote, 0);
        assert.equal(view.votes.up, 0);
        assert.equal(view.votes.down, 0);
      }

      // Both commands were accepted: two audits chained from 0 to the
      // terminal effective value, and two completed receipts.
      const audits = await voteAudits(voter.accountId, collectionId);
      assert.equal(audits.length, 2);
      assertAuditChain(audits, rows.length === 1 ? 1 : 0);
      const receipts = await voteReceipts(voter.accountId);
      assert.deepEqual(receipts.map((row) => row.command_id).sort(),
        [voteCommandId, cancelCommandId].sort());
      for (const receipt of receipts) {
        assert.equal(receipt.result_status, 200);
        assert.ok(receipt.completed_at !== null);
      }
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a concurrent duplicate command id has one winner and a deterministic same-id retry', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'owner4');
      const voter = await session(factory, 'dupe');
      const collectionId = `vcon-dupe-${id12()}`;
      await seedCollection(collectionId, owner.subjectId, 'public',
        `vcon-dupe-${randomUUID().slice(0, 8)}`);

      const client = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const target = (await client.resolveTarget(
        { kind: 'collection', id: collectionId })).target;

      // §149 "COMMIT 响应丢失按同 ID 查询／重试恢复": two requests carrying
      // the SAME command id race; the receipt claim admits exactly one.
      const commandId = randomUUID();
      const outcomes = await Promise.all([
        attemptVote(client, target, 1, commandId),
        attemptVote(client, target, 1, commandId),
      ]);
      const succeeded = outcomes.filter((outcome) => outcome.ok);
      const blocked = outcomes.filter((outcome) => !outcome.ok);
      assert.ok(succeeded.length >= 1, 'exactly one in-flight claimant must win');
      assert.equal(succeeded.length + blocked.length, 2);
      for (const outcome of succeeded) assert.equal(outcome.state!.myVote, 1);
      if (succeeded.length === 2) {
        // The loser claimed after the winner committed: an exact replay.
        assert.deepEqual(succeeded[1]!.state, succeeded[0]!.state);
      }
      for (const outcome of blocked) {
        // The loser claimed while the winner held the advisory lock.
        assert.ok(isProductClientError(outcome.error, 409, 'command_in_progress'));
      }

      // A post-settle retry with the same id and body is the deterministic
      // replay — the recovery path for a lost COMMIT response.
      const replay = await client.setVote({ target, value: 1 }, commandId);
      assert.deepEqual(replay, succeeded[0]!.state);

      // One logical command ⇒ one vote row, one audit event, one receipt.
      const rows = await voteRows(voter.accountId, 'collection', collectionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.value, 1);
      const audits = await voteAudits(voter.accountId, collectionId);
      assert.equal(audits.length, 1);
      assert.equal(audits[0]!.previousValue, 0);
      assert.equal(audits[0]!.value, 1);
      const receipts = await voteReceipts(voter.accountId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]!.command_id, commandId);
      assert.equal(receipts[0]!.result_status, 200);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('vote, comment, edit and hide writes leave the node canonical revision untouched', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await session(factory, 'canon-owner');
      const voter = await session(factory, 'canon-voter');
      const author = await session(factory, 'canon-author');
      const collectionId = `vcon-canon-${id12()}`;
      const nodeId = `vcon-canon-node-${id12()}`;
      const rootId = await seedCollection(collectionId, owner.subjectId, 'public',
        `vcon-canon-${randomUUID().slice(0, 8)}`);
      await seedBookmark(nodeId, collectionId, rootId);

      const canonicalSnapshot = async () => {
        const node = await isolated.runtime.pool.query(
          `select resource_revision, children_revision, title, url, position_token,
                  created_at, updated_at, deleted_at
           from nodes where collection_id=$1 and id=$2`, [collectionId, nodeId]);
        const collection = await isolated.runtime.pool.query(
          `select resource_revision, content_revision, policy_revision, commit_ordinal,
                  title, visibility, publication_slug, published_at,
                  created_at, updated_at, deleted_at
           from collections where id=$1`, [collectionId]);
        const generation = await isolated.runtime.pool.query(
          `select generation, created_at, updated_at
           from community_bookmark_generations where collection_id=$1 and node_id=$2`,
          [collectionId, nodeId]);
        return { node: node.rows[0], collection: collection.rows[0],
          generation: generation.rows[0] };
      };
      const before = await canonicalSnapshot();

      const voterClient = createProductCommunityClient({ origin, sessionCookie: voter.cookie,
        originHeader: config.productOrigin, csrfToken: voter.csrfToken });
      const authorClient = createProductCommunityClient({ origin, sessionCookie: author.cookie,
        originHeader: config.productOrigin, csrfToken: author.csrfToken });
      const ownerClient = createProductCommunityClient({ origin, sessionCookie: owner.cookie,
        originHeader: config.productOrigin, csrfToken: owner.csrfToken });
      const target = (await voterClient.resolveTarget(
        { kind: 'bookmark', id: nodeId, collectionId })).target;
      assert.match(target.generation, /^bm-gen-/u);
      assert.equal(target.generation, before.generation.generation);

      // The full interaction write path over real HTTP: vote, comment,
      // author edit under the comment ETag, curator hide under the curation
      // ETag — each commits its own receipt, authority rows and audit.
      const vote = await voterClient.setVote({ target, value: 1 }, randomUUID());
      assert.equal(vote.myVote, 1);
      const comment = await authorClient.createComment(
        { target, body: 'Interaction write', replyToId: null }, randomUUID());
      const fresh = await authorClient.getCommentWithEtag(comment.id);
      const edited = await authorClient.editComment(comment.id,
        { body: 'Interaction write (edited)' }, fresh.etag!, randomUUID());
      assert.equal(edited.data.revision, '2');
      const curation = await ownerClient.getCuration(comment.id);
      const hidden = await ownerClient.setCuration(comment.id,
        { hidden: true, reason: 'curated' }, curation.etag!, randomUUID());
      assert.equal(hidden.data.hidden, true);

      // §38: the writes landed in community tables, but the target node row,
      // its minted generation and the parent collection row are identical —
      // interactions never move canonical revisions or updated_at.
      assert.deepEqual((await voteRows(voter.accountId, 'bookmark', nodeId))
        .map((row) => row.value), [1]);
      const commentRow = await isolated.runtime.pool.query<{
        revision: string; state: string;
      }>(
        `select revision::text as revision, state from community_comments where comment_id=$1`,
        [comment.id]);
      assert.equal(commentRow.rows[0]?.revision, '2');
      assert.equal(commentRow.rows[0]?.state, 'visible');
      const curationRow = await isolated.runtime.pool.query<{ hidden: boolean }>(
        `select hidden from community_comment_curations where comment_id=$1`, [comment.id]);
      assert.equal(curationRow.rows[0]?.hidden, true);
      assert.deepEqual(await canonicalSnapshot(), before);
    } finally {
      await app.close();
    }
  }, 60_000);
});
