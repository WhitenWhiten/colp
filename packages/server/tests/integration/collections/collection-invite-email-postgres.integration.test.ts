/**
 * SC-04 transactional collection invite email against real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  inviteMember,
  processOne,
  revokeInvite,
  type CollaborationActor,
  type CollaborationCommandPorts,
} from '../../../src/modules/access-policy/index.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsEditorReadUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresCollaborationCommandPorts,
  createPostgresCollaborationUnitOfWork,
} from '../../../src/infrastructure/collaboration/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresInviteEmailDeliveryRepository, inviteEmailClaimDueSql } from '../../../src/infrastructure/access-policy/invite-email-worker-postgres.js';
import {
  createInviteEmailAdapter,
  createInviteEmailMailboxSink,
  type InviteEmailMailboxEntry,
} from '../../../src/infrastructure/email/invite-email-adapter.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://known.example';
const INVITE_201_KEYS = ['collectionId', 'expiresAt', 'inviteId', 'policyEtag', 'role'];
const OWNER_ACCOUNT = 'acct-owner-sc04';
const OWNER_SUBJECT = 'subject-owner-sc04';
const OWNER_EMAIL = 'owner-sc04@example.test';
const OWNER_AUTH = 'auth-owner-sc04';
const KNOWN_ACCOUNT = 'acct-known-sc04';
const KNOWN_SUBJECT = 'subject-known-sc04';
const KNOWN_EMAIL = 'known-sc04@example.test';
const KNOWN_AUTH = 'auth-known-sc04';
const SUPPRESSED_ACCOUNT = 'acct-suppressed-sc04';
const SUPPRESSED_SUBJECT = 'subject-suppressed-sc04';
const SUPPRESSED_EMAIL = 'suppressed-sc04@example.test';
const SUPPRESSED_AUTH = 'auth-suppressed-sc04';
const UNKNOWN_EMAIL = 'unknown-sc04@example.test';
const COLLECTION_ID = 'col-sc04-invite-email';
const ROOT_ID = 'root-sc04-invite-email';
const COMMAND_KNOWN = '10000000-0000-4000-8000-00000000c401';
const COMMAND_UNKNOWN = '10000000-0000-4000-8000-00000000c402';
const COMMAND_REPLAY = '10000000-0000-4000-8000-00000000c403';
const COMMAND_FAIL = '10000000-0000-4000-8000-00000000c404';
const COMMAND_REVOKE = '10000000-0000-4000-8000-00000000c405';
const COMMAND_REVOKE_INVITE = '10000000-0000-4000-8000-00000000c406';
const COMMAND_DISABLED = '10000000-0000-4000-8000-00000000c407';
const COMMAND_SUPPRESS = '10000000-0000-4000-8000-00000000c408';
const COMMAND_LEASE_CRASH = '10000000-0000-4000-8000-00000000c413';
const COMMAND_LEASE_LIVE = '10000000-0000-4000-8000-00000000c414';
const FINGERPRINT = (label: string) => label.padEnd(64, '0');

describeWithPostgres('collection invite email postgres delivery', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc04_invite_email', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixtures(isolated);
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'sc04-editor-cursor-key',
      COLLABORATION_INVITE_EMAIL_ENABLED: 'true',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
  }, 180_000);

  afterAll(async () => isolated?.close());

  function ownerActor(): CollaborationActor {
    return {
      principalId: OWNER_ACCOUNT,
      subjectId: OWNER_SUBJECT,
      kind: 'account',
      email: OWNER_EMAIL,
    };
  }

  async function run<Result>(
    work: (ports: CollaborationCommandPorts) => Promise<Result>,
    options: { readonly inviteEmailEnabled?: boolean } = {},
  ): Promise<Result> {
    return createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => (
      work(createPostgresCollaborationCommandPorts(transaction, {
        inviteEmailEnabled: options.inviteEmailEnabled ?? true,
      }))
    ));
  }

  function captureLogger() {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: unknown, _encoding: unknown, done: () => void) {
        lines.push(String(chunk));
        done();
      },
    });
    return { logger: createLogger('info', destination), lines };
  }

  function processor(
    sink: ReturnType<typeof createInviteEmailMailboxSink>,
    logger = createLogger('silent'),
    sender = createInviteEmailAdapter({ provider: sink.provider, logger }),
  ) {
    const repository = createPostgresInviteEmailDeliveryRepository(isolated.runtime.pool);
    return {
      sender,
      repository,
      processOne: (inviteId?: string, signal?: AbortSignal) => processOne({
        repository,
        sender,
        loginUrl: `${ORIGIN}/login?returnTo=/library`,
        leaseDurationMs: 30_000,
        ...(inviteId !== undefined ? { inviteId } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
    };
  }

  async function drain(
    processOneFn: (inviteId?: string) => Promise<{ readonly disposition: string }>,
    inviteId?: string,
  ): Promise<number> {
    let count = 0;
    for (let i = 0; i < 8; i += 1) {
      const result = await processOneFn(inviteId);
      if (result.disposition === 'idle') break;
      count += 1;
    }
    return count;
  }

  test('known and unknown each produce exactly one mailbox entry with the shared CTA and subject', async () => {
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink);
    const known = await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_KNOWN, fingerprint: FINGERPRINT('known') },
      collectionId: COLLECTION_ID,
      email: KNOWN_EMAIL,
      role: 'editor',
      inviteId: 'invite-known-sc04',
    }));
    const unknown = await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_UNKNOWN, fingerprint: FINGERPRINT('unknown') },
      collectionId: COLLECTION_ID,
      email: UNKNOWN_EMAIL,
      role: 'editor',
      inviteId: 'invite-unknown-sc04',
    }));
    assert.equal(known.kind, 'invited');
    assert.equal(unknown.kind, 'invited');
    assert.equal(sink.entries.length, 0, '201/invite transaction commits before mailbox has mail');

    await drain(runOne, 'invite-known-sc04');
    await drain(runOne, 'invite-unknown-sc04');
    assert.equal(sink.entries.length, 2);
    const knownMail = sink.entries.find((entry) => entry.to === KNOWN_EMAIL);
    const unknownMail = sink.entries.find((entry) => entry.to === UNKNOWN_EMAIL);
    assert.ok(knownMail, 'known mailbox missing');
    assert.ok(unknownMail, 'unknown mailbox missing');
    assert.equal(knownMail.subject, unknownMail.subject);
    assert.equal(knownMail.subject, "You've been invited to collaborate on Know-N");
    assert.match(knownMail.textBody, /\/login\?returnTo=\/library/u);
    assert.match(unknownMail.textBody, /\/login\?returnTo=\/library/u);
    assert.equal(normalizeBody(knownMail), normalizeBody(unknownMail));
    assert.equal(knownMail.purpose, 'collaboration-invite');
    assert.equal(unknownMail.purpose, 'collaboration-invite');
  });

  test('provider throw leaves the invite pending and the delivery retryable', async () => {
    const throwing = {
      async send() {
        throw new Error('provider boom');
      },
    };
    const sender = createInviteEmailAdapter({
      provider: throwing,
      logger: createLogger('silent'),
    });
    const repository = createPostgresInviteEmailDeliveryRepository(isolated.runtime.pool);
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_FAIL, fingerprint: FINGERPRINT('fail') },
      collectionId: COLLECTION_ID,
      email: 'fail-sc04@example.test',
      role: 'viewer',
      inviteId: 'invite-fail-sc04',
    }));
    const result = await processOne({
      repository,
      sender,
      loginUrl: `${ORIGIN}/login?returnTo=/library`,
      leaseDurationMs: 30_000,
      inviteId: 'invite-fail-sc04',
    });
    assert.equal(result.disposition, 'retryable');
    const invite = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_invites where id = 'invite-fail-sc04'`,
    );
    assert.equal(invite.rows[0]?.status, 'pending');
    const delivery = await isolated.runtime.pool.query<{ state: string }>(
      `select state from collection_invite_deliveries where invite_id = 'invite-fail-sc04'`,
    );
    assert.equal(delivery.rows[0]?.state, 'retryable');
  });

  test('command replay does not send a second letter', async () => {
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink);
    const first = await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_REPLAY, fingerprint: FINGERPRINT('replay') },
      collectionId: COLLECTION_ID,
      email: 'replay-sc04@example.test',
      role: 'editor',
      inviteId: 'invite-replay-sc04',
    }));
    const second = await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_REPLAY, fingerprint: FINGERPRINT('replay') },
      collectionId: COLLECTION_ID,
      email: 'replay-sc04@example.test',
      role: 'editor',
      inviteId: 'invite-replay-sc04',
    }));
    assert.equal(first.kind, 'invited');
    assert.equal(second.kind, 'replay');
    await drain(runOne, 'invite-replay-sc04');
    assert.equal(sink.entries.filter((entry) => entry.to === 'replay-sc04@example.test').length, 1);
  });

  test('revoke before send suppresses the delivery and does not send', async () => {
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink);
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_REVOKE, fingerprint: FINGERPRINT('revoke-inv') },
      collectionId: COLLECTION_ID,
      email: 'revoke-sc04@example.test',
      role: 'viewer',
      inviteId: 'invite-revoke-sc04',
    }));
    assert.equal(sink.entries.length, 0);
    await run((ports) => revokeInvite(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_REVOKE_INVITE, fingerprint: FINGERPRINT('revoke') },
      collectionId: COLLECTION_ID,
      inviteId: 'invite-revoke-sc04',
    }));
    await drain(runOne, 'invite-revoke-sc04');
    assert.equal(sink.entries.filter((entry) => entry.to === 'revoke-sc04@example.test').length, 0);
    const delivery = await isolated.runtime.pool.query<{ state: string }>(
      `select state from collection_invite_deliveries where invite_id = 'invite-revoke-sc04'`,
    );
    assert.equal(delivery.rows[0]?.state, 'suppressed');
  });

  test('enabled=false inserts suppressed not_configured, sends 0 letters, invite stays pending', async () => {
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink);
    const invited = await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_DISABLED, fingerprint: FINGERPRINT('disabled') },
      collectionId: COLLECTION_ID,
      email: 'disabled-sc04@example.test',
      role: 'editor',
      inviteId: 'invite-disabled-sc04',
    }), { inviteEmailEnabled: false });
    assert.equal(invited.kind, 'invited');
    await drain(runOne, 'invite-disabled-sc04');
    assert.equal(sink.entries.filter((entry) => entry.to === 'disabled-sc04@example.test').length, 0);
    const invite = await isolated.runtime.pool.query<{ status: string }>(
      `select status from collection_invites where id = 'invite-disabled-sc04'`,
    );
    assert.equal(invite.rows[0]?.status, 'pending');
    const delivery = await isolated.runtime.pool.query<{ state: string; last_error_category: string | null }>(
      `select state, last_error_category from collection_invite_deliveries
        where invite_id = 'invite-disabled-sc04'`,
    );
    assert.equal(delivery.rows[0]?.state, 'suppressed');
    assert.equal(delivery.rows[0]?.last_error_category, 'not_configured');
  });

  test('suppression table hit for a known account sends 0 letters', async () => {
    await isolated.runtime.pool.query(
      `insert into notification_email_suppressions(recipient_account_id, source, occurred_at)
       values ($1, 'bounce', current_timestamp)
       on conflict (recipient_account_id) do nothing`,
      [SUPPRESSED_ACCOUNT],
    );
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink);
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_SUPPRESS, fingerprint: FINGERPRINT('suppress') },
      collectionId: COLLECTION_ID,
      email: SUPPRESSED_EMAIL,
      role: 'viewer',
      inviteId: 'invite-suppress-sc04',
    }));
    await drain(runOne, 'invite-suppress-sc04');
    assert.equal(sink.entries.filter((entry) => entry.to === SUPPRESSED_EMAIL).length, 0);
    const delivery = await isolated.runtime.pool.query<{ state: string }>(
      `select state from collection_invite_deliveries where invite_id = 'invite-suppress-sc04'`,
    );
    assert.equal(delivery.rows[0]?.state, 'suppressed');
  });

  test('HTTP 201 JSON keys are identical to the SC-02 snapshot', async () => {
    const app = composeApp();
    try {
      const owner = await issueTestSession({
        factory,
        subject: 'sc04-http-owner',
        handle: 'sc04httpowner',
        email: 'sc04-http-owner@example.test',
        displayName: 'Http Owner',
      });
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c410'),
        payload: { kind: 'bookmarks', title: 'HTTP invite keys', summary: null },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const collectionId = created.json().collection.id as string;
      const members = await app.inject({
        method: 'GET',
        url: `/api/v1/collections/${collectionId}/members`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(members.statusCode, 200, members.payload);
      const invited = await app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionId}/members/invites`,
        headers: mutationHeaders(owner, '10000000-0000-4000-8000-00000000c411', {
          'if-match': members.json().policyEtag as string,
        }),
        payload: { email: 'http-keys-sc04@example.test', role: 'editor' },
      });
      assert.equal(invited.statusCode, 201, invited.payload);
      const body = invited.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), INVITE_201_KEYS);
      assert.equal(Object.hasOwn(body, 'emailQueued'), false);
      assert.equal(Object.hasOwn(body, 'accountFound'), false);
    } finally {
      await app.close();
    }
  });

  test('expired leased delivery is claimed on the next claimDue (crash recovery)', async () => {
    const inviteId = 'invite-lease-crash-sc04';
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_LEASE_CRASH, fingerprint: FINGERPRINT('lease-crash') },
      collectionId: COLLECTION_ID,
      email: 'lease-crash-sc04@example.test',
      role: 'viewer',
      inviteId,
    }));
    await isolated.runtime.pool.query(
      `update collection_invite_deliveries
          set state='leased', attempt_count=1, state_revision=state_revision+1,
              leased_until=current_timestamp - interval '2 minutes',
              updated_at=current_timestamp
        where invite_id=$1`,
      [inviteId],
    );
    const repository = createPostgresInviteEmailDeliveryRepository(isolated.runtime.pool);
    const claim = await repository.claimDue({
      limit: 1, leaseDurationMs: 60_000, inviteId,
    });
    assert.ok(claim, 'expired leased row must be claimed after a crash');
    assert.equal(claim.inviteId, inviteId);
    assert.equal(claim.attemptCount, 2);
    const row = await isolated.runtime.pool.query<{ state: string; leased_until: Date }>(
      `select state, leased_until from collection_invite_deliveries where invite_id=$1`,
      [inviteId],
    );
    assert.equal(row.rows[0]?.state, 'leased');
    assert.ok(row.rows[0]!.leased_until.getTime() > Date.now(), 'crash recovery must install a live lease');
  });

  test('two concurrent claimDue calls yield one winner and a live lease is not stolen', async () => {
    const inviteId = 'invite-lease-live-sc04';
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_LEASE_LIVE, fingerprint: FINGERPRINT('lease-live') },
      collectionId: COLLECTION_ID,
      email: 'lease-live-sc04@example.test',
      role: 'viewer',
      inviteId,
    }));
    const repository = createPostgresInviteEmailDeliveryRepository(isolated.runtime.pool);
    const [first, second] = await Promise.all([
      repository.claimDue({ limit: 1, leaseDurationMs: 60_000, inviteId }),
      repository.claimDue({ limit: 1, leaseDurationMs: 60_000, inviteId }),
    ]);
    const winners = [first, second].filter((claim) => claim !== null);
    assert.equal(winners.length, 1, 'exactly one concurrent claimDue may win a live lease');
    assert.equal(winners[0]?.inviteId, inviteId);
    assert.equal(winners[0]?.attemptCount, 1);
    const stolen = await repository.claimDue({
      limit: 1, leaseDurationMs: 60_000, inviteId,
    });
    assert.equal(stolen, null, 'a second worker must not steal a live lease');
  });

  test('claimDue SQL uses pending|retryable-or-expired-leased and SKIP LOCKED', async () => {
    const indexes = await isolated.runtime.pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = any($1::text[])`,
      [[
        'collection_invite_deliveries_due_idx',
        'collection_invite_deliveries_leased_until_idx',
      ]],
    );
    assert.deepEqual(
      new Set(indexes.rows.map((row) => row.indexname)),
      new Set([
        'collection_invite_deliveries_due_idx',
        'collection_invite_deliveries_leased_until_idx',
      ]),
    );
    const sql = inviteEmailClaimDueSql(false);
    assert.match(sql, /state in \('pending','retryable'\)/i);
    assert.match(sql, /state='leased' and leased_until <= current_timestamp/i);
    assert.match(sql, /for update skip locked/i);
    const plan = await isolated.runtime.pool.query<{ 'QUERY PLAN': string }>(
      `explain (format text) ${sql}`,
      [1, 60_000],
    );
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(text, /collection_invite_deliveries/i);
    assert.match(text, /pending/i);
    assert.match(text, /leased/i);
  });

  test('logs fixture contains no recipient address', async () => {
    const { logger, lines } = captureLogger();
    const sink = createInviteEmailMailboxSink();
    const { processOne: runOne } = processor(sink, logger);
    await run((ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: '10000000-0000-4000-8000-00000000c412', fingerprint: FINGERPRINT('log') },
      collectionId: COLLECTION_ID,
      email: 'log-sc04@example.test',
      role: 'editor',
      inviteId: 'invite-log-sc04',
    }));
    await drain(runOne, 'invite-log-sc04');
    const logText = lines.join('\n');
    assert.doesNotMatch(logText, /log-sc04@example\.test/u);
    assert.doesNotMatch(logText, /unknown-sc04@example\.test/u);
    assert.doesNotMatch(logText, /known-sc04@example\.test/u);
    assert.doesNotMatch(logText, /"to"/u);
  });

  function composeApp() {
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
        oidcTransactionSecrets: config.oidcTransactionSecrets,
      }),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      collectionsEditorReadUnitOfWork: createPostgresCollectionsEditorReadUnitOfWork(isolated.runtime.db, {
        cursorSigner: createProductEditorCursorSigner({
          current: config.productEditorCursor.current,
          previous: config.productEditorCursor.previous,
        }),
        cursorTtlMs: config.productEditorCursor.ttlMs,
      }),
      browserSessionAuthority: factory.authority,
      productCollaboration: {
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db, {
          oidcTransactionSecrets: config.oidcTransactionSecrets,
        }),
        allowedOrigins: [ORIGIN],
        unitOfWork: createPostgresCollaborationUnitOfWork(isolated.runtime.db, {
          inviteEmailEnabled: true,
        }),
        rateLimiter: createMemoryCollaborationInviteRateLimiter({
          keySecret: Buffer.alloc(32, 24),
          environment: 'test',
        }),
        cursors: createTestCollaborationListCursors(),
      },
    });
  }
});

function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
    ...extra,
  };
}

function normalizeBody(entry: InviteEmailMailboxEntry): string {
  return entry.textBody.replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?/gu, 'DATE');
}

async function seedFixtures(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await seedAccount(client, {
      accountId: OWNER_ACCOUNT, subjectId: OWNER_SUBJECT, email: OWNER_EMAIL,
      authUserId: OWNER_AUTH, displayName: 'Ada Owner',
    });
    await seedAccount(client, {
      accountId: KNOWN_ACCOUNT, subjectId: KNOWN_SUBJECT, email: KNOWN_EMAIL,
      authUserId: KNOWN_AUTH, displayName: 'Known Invitee',
    });
    await seedAccount(client, {
      accountId: SUPPRESSED_ACCOUNT, subjectId: SUPPRESSED_SUBJECT, email: SUPPRESSED_EMAIL,
      authUserId: SUPPRESSED_AUTH, displayName: 'Suppressed Invitee',
    });
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
      [COLLECTION_ID, ROOT_ID],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       values ($1,$2,'Private collab fixture','bookmarks','private',null,null,
         $3,true,'resource-sc04-1','content-sc04-1','policy-sc04-1',1,current_timestamp,current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT, ROOT_ID],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [ROOT_ID, COLLECTION_ID],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1,$2,'owner',current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedAccount(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly accountId: string;
    readonly subjectId: string;
    readonly email: string;
    readonly authUserId: string;
    readonly displayName: string;
  },
): Promise<void> {
  await client.query(
    `insert into accounts(id, subject_id, status, email, security_epoch, created_at)
     values ($1,$2,'active',$3,0,current_timestamp)`,
    [input.accountId, input.subjectId, input.email],
  );
  await client.query(
    `insert into "auth_users" ("id","name","email","emailVerified")
     values ($1,$2,$3,true)`,
    [input.authUserId, input.displayName, input.email],
  );
  await client.query(
    `insert into auth_user_account_map(auth_user_id, account_id)
     values ($1,$2)`,
    [input.authUserId, input.accountId],
  );
  await client.query(
    `insert into profiles(account_id, display_name, updated_at)
     values ($1,$2,current_timestamp)`,
    [input.accountId, input.displayName],
  );
}
