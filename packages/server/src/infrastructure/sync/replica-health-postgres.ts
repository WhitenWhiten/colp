import { sql, type Kysely } from 'kysely';
import { ReplicaHealthError, type ReplicaHealthRecorder } from '../../modules/sync/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { isJoseSyncCredentialRevoked } from './postgres/sync-jose-credential-revocation-postgres.js';

/**
 * Replica reports are display facts. Authority is the verified Sync credential
 * alone: a stopped extension may hold no live Session, and its credential may
 * have rotated since its last Session, so neither is required. The credential's
 * active account must own the named, unretired replica.
 */
export function createPostgresReplicaHealthRecorder(db: Kysely<DatabaseSchema>): ReplicaHealthRecorder {
  const recorder: ReplicaHealthRecorder = {
    async record({ credential, report }) {
      if (!credential.scopes.includes('known.sync')) throw new ReplicaHealthError('invalid_token');
      const account = await db.selectFrom('account_identities as identity')
        .innerJoin('accounts as account', 'account.id', 'identity.account_id')
        .select(['account.id as account_id', 'account.status'])
        .where('identity.issuer', '=', credential.issuer)
        .where('identity.subject', '=', credential.subject).executeTakeFirst();
      if (!account || account.status !== 'active' || await isJoseSyncCredentialRevoked(db, {
        issuer: credential.issuer, subject: credential.subject, tokenId: credential.credentialId,
        tokenDigest: credential.credentialDigest,
        issuedAtSeconds: Math.floor(credential.credentialIssuedAt.getTime() / 1_000), clockSkewSeconds: 0,
      })) throw new ReplicaHealthError('invalid_token');
      const replica = await db.selectFrom('sync_replicas').select(['account_id', 'status'])
        .where('replica_id', '=', report.replicaId).executeTakeFirst();
      if (!replica || replica.account_id !== account.account_id) throw new ReplicaHealthError('resource_not_found');
      if (replica.status === 'retired') throw new ReplicaHealthError('replica_retired');
      const issues = JSON.stringify(report.issues.items);
      const stored = await sql<{ health_revision: string }>`
        INSERT INTO sync_replica_reports AS report (replica_id, account_id, health_state, health_code, health_since,
          health_revision, health_reported_at, issue_total, issues, extension_version)
        VALUES (${report.replicaId}, ${account.account_id}, ${report.state}, ${report.code ?? null},
          ${new Date(report.since)}, ${report.revision}, clock_timestamp(), ${report.issues.total},
          ${issues}::jsonb, ${report.extensionVersion ?? null})
        ON CONFLICT (replica_id) DO UPDATE SET health_state = EXCLUDED.health_state,
          health_code = EXCLUDED.health_code, health_since = EXCLUDED.health_since,
          health_revision = EXCLUDED.health_revision, health_reported_at = EXCLUDED.health_reported_at,
          issue_total = EXCLUDED.issue_total, issues = EXCLUDED.issues,
          extension_version = EXCLUDED.extension_version
        WHERE report.health_revision IS NULL OR report.health_revision < EXCLUDED.health_revision
        RETURNING health_revision::text`.execute(db);
      if (stored.rows.length === 1) return { accepted: true, revision: report.revision };
      const current = await db.selectFrom('sync_replica_reports').select('health_revision')
        .where('replica_id', '=', report.replicaId).executeTakeFirst();
      return { accepted: false, revision: Number(current?.health_revision ?? report.revision) };
    },
    async recordAckWarnings({ replicaId, warnings }) {
      await sql`
        INSERT INTO sync_replica_reports AS report (replica_id, account_id, ack_warnings, ack_warnings_at)
        SELECT replica.replica_id, replica.account_id, ${JSON.stringify(warnings)}::jsonb, clock_timestamp()
        FROM sync_replicas AS replica WHERE replica.replica_id = ${replicaId}
        ON CONFLICT (replica_id) DO UPDATE SET ack_warnings = EXCLUDED.ack_warnings,
          ack_warnings_at = EXCLUDED.ack_warnings_at`.execute(db);
    },
  };
  return Object.freeze(recorder);
}
