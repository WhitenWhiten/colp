import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const migrationUrl = new URL('../../../migrations/202607300100_sync_pull_recovery_proofs.ts', import.meta.url);

test('P3-38 migration separates bounded digest-only recovery proof from Ack cursor evidence', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'CREATE TABLE sync_pull_cursor_recovery_proofs',
    'cursor_digest',
    'authority_session_id',
    'authority_lifecycle_revision',
    'account_id',
    'collection_id',
    'replica_id',
    'lease_generation',
    'policy_revision',
    'protocol_version',
    'page_limit',
    'tuple_commit_ordinal',
    'tuple_stream_kind',
    'tuple_stable_id',
    'purge_commit_ordinal',
    'proof_expires_at',
    'consumed_at',
    'sync_pull_cursor_recovery_proofs_cleanup_idx',
    'recovery_pull_page_limit',
  ]) assert.match(source, new RegExp(fragment, 'u'));
  assert.match(source, /UNIQUE\s*\(replica_id, cursor_digest\)/u);
  assert.doesNotMatch(source, /cursor_value|\bcursor text\b/u);
  assert.match(source, /proof_expires_at > cursor_expires_at/u);
  assert.match(source, /ON DELETE CASCADE/u);
  assert.doesNotMatch(source, /secret|credential_digest|bookmark|native_id|url\b/iu);
});

test('P3-38 proof cleanup is bounded by recovery completion or retirement without weakening Ack immutability', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.match(source, /status IN \('recovery_required', 'retired'\)/u);
  assert.match(source, /proof_expires_at <= current_timestamp/u);
  assert.match(source, /sync_pull_cursor_evidence_immutable/u);
  assert.doesNotMatch(source, /DROP TABLE sync_pull_cursor_evidence/u);
});

test('P3-38 destructive down removes redacted evidence before restoring the legacy NOT NULL constraint', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  const down = source.slice(source.indexOf('export async function down'));
  const deleteRedacted = down.indexOf('DELETE FROM sync_pull_cursor_evidence WHERE cursor IS NULL');
  const keepAcked = down.indexOf('NOT EXISTS');
  const unredactAcked = down.indexOf("UPDATE sync_pull_cursor_evidence SET cursor = 'redacted' WHERE cursor IS NULL");
  const restoreNotNull = down.indexOf('ALTER TABLE sync_pull_cursor_evidence ALTER COLUMN cursor SET NOT NULL');
  assert.ok(deleteRedacted >= 0);
  assert.ok(keepAcked > deleteRedacted);
  assert.ok(unredactAcked > keepAcked);
  assert.ok(restoreNotNull > unredactAcked);
  assert.match(down, /sync_ack_receipts/u);
  assert.match(down, /ALTER TABLE sync_bootstrap_snapshots DROP COLUMN recovery_pull_page_limit/u);
});

test('P3-38 config fails closed unless proof retention covers cursor TTL and one Session handoff', () => {
  const key = (value: number) => Buffer.alloc(32, value).toString('base64');
  const env = {
    DATABASE_URL: 'postgres://localhost/known', SYNC_SESSION_ENABLED: 'true',
    // Shape-only placeholder (c8af60ab FIX-H-001 precedent): the legacy OIDC
    // JWKS check requires a coherent issuer/JWKS triple in non-test-provider
    // mode; this suite exercises Sync proof-retention config, not OIDC.
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example', SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-api', SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example/authorize',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example/token', SYNC_OAUTH_JWKS_URI: 'https://issuer.example/jwks',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb',
    SYNC_SESSION_REPLAY_KEY: key(51), SYNC_SNAPSHOT_CURSOR_KEY: key(52),
    SYNC_SNAPSHOT_CURSOR_KEY_ID: 'snapshot-v1', SYNC_PULL_CURSOR_KEY: key(53),
    SYNC_PULL_CURSOR_KEY_ID: 'pull-v1', SYNC_RECOVERY_CAPABILITY_KEY: key(54),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1', SYNC_PULL_LINEAGE_KEY: key(55),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1', SYNC_SESSION_DURATION_SECONDS: '900',
    SYNC_PULL_CURSOR_TTL_MS: '600000', SYNC_PULL_RECOVERY_PROOF_RETENTION_MS: '1500000',
  } satisfies NodeJS.ProcessEnv;
  assert.equal(loadConfig(env).syncSession?.pull.recoveryProofRetentionMs, 1_500_000);
  assert.throws(() => loadConfig({ ...env, OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    SYNC_PULL_RECOVERY_PROOF_RETENTION_MS: '1499999' }),
    /must cover cursor TTL plus one Session handoff window/u);
});
