/**
 * Task B2: controlled legacy OIDC account import (backfill lane).
 *
 * Migrates existing Know-N business accounts into Better Auth WITHOUT
 * forging password proof and WITHOUT implicit email merging (G1 ADR §11;
 * plan §8 Task B2):
 *
 * - read-only inputs are `accounts`, `profiles`, `profile_handles` and
 *   `account_identities`; outputs are the G1-frozen auth/mapping/archive
 *   tables (`auth_users`, `auth_user_account_map`,
 *   `legacy_oidc_identity_archive`);
 * - every migratable active account gets ONE Better Auth user (no password
 *   credential, no session, no raw token), a unique bidirectional mapping,
 *   and one archive row per legacy (issuer, subject) identity. The legacy
 *   `account_identities` rows are preserved untouched for the extension
 *   chain;
 * - `emailVerified` is ALWAYS false on import: the legacy email_verified
 *   claim is only recorded as an archive fact (`emailVerifiedClaim`) and is
 *   never converted into local password ownership (G0 decision; plan §8 B2
 *   step 4);
 * - conflicts (duplicate email on the auth_users surface, duplicate
 *   (issuer, subject) archive pair, corrupt mapping) are fail-closed: the
 *   default stops the whole batch BEFORE any write; `quarantine: true`
 *   records them in the report and imports only the non-conflicting
 *   accounts. A conflicting account is never resolved by "picking the first
 *   row";
 * - apply is idempotent and resumable: per-account transactions plus
 *   deterministic auth user ids and the archive (issuer, subject) unique
 *   pair make repeated runs skip already-imported accounts; a mid-run
 *   failure leaves committed accounts in place and the next run resumes;
 * - the report carries an immutable sha256 digest over its canonical JSON
 *   and the ADR §15 validation queries (recorded before and after apply).
 *
 * 假阴性防护: the planner sorts accounts by id (order-independent) and the
 * integration suite seeds fixtures in randomized order; per-account
 * transaction rollback is exercised with a fault injector.
 *
 * 假阳性防护: apply NEVER inserts into `auth_accounts` / `auth_sessions` /
 * `auth_verifications` (no credential, no browser session, no proof rows),
 * NEVER writes `accounts`/`profiles`/`profile_handles`/`account_identities`,
 * and NEVER attaches an existing auth user to a business account based on
 * email equality (duplicate email is a conflict, not an adoption).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuthUserAccountMapping } from '../../identity/index.js';

/** Archive `migration_source` recorded for rows written by this import. */
export const LEGACY_IMPORT_MIGRATION_SOURCE = 'legacy-oidc-import-v1';

/** Deterministic auth user id prefix: `legacy-import-v1:<accountId>`. */
export const LEGACY_AUTH_USER_ID_PREFIX = 'legacy-import-v1';

export type LegacyAccountStatus = 'active' | 'disabled' | 'deleted';

export interface LegacyOidcIdentityFact {
  readonly issuer: string;
  readonly subject: string;
}

/** Read-only business account facts consumed by the import (accounts + profiles + account_identities). */
export interface LegacyAccountFacts {
  readonly accountId: string;
  readonly email: string | null;
  readonly status: LegacyAccountStatus;
  readonly deletedAt: Date | null;
  readonly displayName: string | null;
  readonly oidcIdentities: readonly LegacyOidcIdentityFact[];
}

export interface LegacyImportAuthUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface LegacyImportMappingFact {
  readonly authUserId: string;
  readonly accountId: string;
}

export interface LegacyImportArchiveFact {
  readonly issuer: string;
  readonly subject: string;
  readonly accountId: string;
}

/** Snapshot of the existing auth/mapping/archive tables used by the planner. */
export interface LegacyImportExistingState {
  readonly authUsersByEmail: ReadonlyMap<string, LegacyImportAuthUser>;
  readonly authUsersById: ReadonlyMap<string, LegacyImportAuthUser>;
  readonly mappingsByAccountId: ReadonlyMap<string, LegacyImportMappingFact>;
  readonly archivesByIssuerSubject: ReadonlyMap<string, LegacyImportArchiveFact>;
}

export type LegacyImportConflictReason = 'duplicate_email' | 'duplicate_subject' | 'corrupt_mapping';

export interface LegacyImportConflict {
  readonly accountId: string;
  readonly reason: LegacyImportConflictReason;
  readonly detail: string;
}

export type LegacyImportSkipReason = 'missing_email' | 'inactive' | 'already_imported';

export interface LegacyImportSkipped {
  readonly accountId: string;
  readonly reason: LegacyImportSkipReason;
  readonly detail: string;
}

export interface LegacyImportOptions {
  /** `migration_source` written to every archive row (1..128 chars). */
  readonly migrationSource: string;
  /**
   * Source fact recorded in `legacy_oidc_identity_archive.email_verified_claim`.
   * NEVER reflected in `auth_users.emailVerified` (that stays false).
   */
  readonly emailVerifiedClaim: boolean;
  /** true = record conflicts in the report and import the rest; false = reject the whole batch. */
  readonly quarantine: boolean;
}

export const DEFAULT_LEGACY_IMPORT_OPTIONS: LegacyImportOptions = {
  migrationSource: LEGACY_IMPORT_MIGRATION_SOURCE,
  emailVerifiedClaim: false,
  quarantine: false,
};

/** Deterministic Better Auth user id for a business account (audit + resume surface). */
export function deriveLegacyAuthUserId(accountId: string): string {
  return `${LEGACY_AUTH_USER_ID_PREFIX}:${accountId}`;
}

/** Display name for the imported auth user: profile display name, else email local part, else account id. */
export function deriveLegacyAuthUserName(fact: LegacyAccountFacts): string {
  const displayName = fact.displayName?.trim();
  if (displayName && displayName.length > 0) return displayName;
  if (fact.email) {
    const local = fact.email.split('@')[0]?.trim();
    if (local && local.length > 0) return local;
  }
  return fact.accountId;
}

function identityPairKey(issuer: string, subject: string): string {
  return `${issuer}\u0000${subject}`;
}

function isCandidate(fact: LegacyAccountFacts): boolean {
  return fact.status === 'active' && fact.email !== null && fact.email.length > 0;
}

export interface LegacyImportPlan {
  readonly migratable: readonly LegacyAccountFacts[];
  readonly skipped: readonly LegacyImportSkipped[];
  readonly conflicts: readonly LegacyImportConflict[];
}

/**
 * Pure planning pass over business account facts + existing auth state.
 *
 * - inactive accounts (disabled/deleted) and active accounts without an
 *   email are skipped with reasons (they are not migratable);
 * - an account that already has a mapping to a live auth user is skipped as
 *   `already_imported` (idempotent re-run); a mapping pointing at a missing
 *   auth user is `corrupt_mapping`;
 * - an email already held by a DIFFERENT auth user is `duplicate_email` (no
 *   implicit merge); an email held by OUR deterministic user id is the heal
 *   path (migratable);
 * - an (issuer, subject) pair already archived for another account is
 *   `duplicate_subject`; same-account pre-archived pairs are healable;
 * - conflicts are never resolved by first-wins: every account involved in a
 *   shared email / shared identity pair is conflicted.
 */
export function planLegacyAccountImport(
  facts: readonly LegacyAccountFacts[],
  state: LegacyImportExistingState,
): LegacyImportPlan {
  const sorted = [...facts].sort((a, b) => a.accountId.localeCompare(b.accountId));
  const conflicts = new Map<string, LegacyImportConflict>();
  const skipped: LegacyImportSkipped[] = [];

  // Pass 1: an email shared by two candidate accounts conflicts BOTH accounts.
  const candidateIdsByEmail = new Map<string, string[]>();
  for (const fact of sorted) {
    if (!isCandidate(fact)) continue;
    const ids = candidateIdsByEmail.get(fact.email as string) ?? [];
    ids.push(fact.accountId);
    candidateIdsByEmail.set(fact.email as string, ids);
  }
  for (const [email, ids] of candidateIdsByEmail) {
    if (ids.length <= 1) continue;
    for (const accountId of ids) {
      conflicts.set(accountId, {
        accountId,
        reason: 'duplicate_email',
        detail: `email "${email}" is shared by accounts ${ids.join(', ')}`,
      });
    }
  }

  // Pass 2: an (issuer, subject) pair shared by two candidates conflicts BOTH accounts.
  const candidateIdsByPair = new Map<string, string[]>();
  for (const fact of sorted) {
    if (!isCandidate(fact) || conflicts.has(fact.accountId)) continue;
    for (const identity of fact.oidcIdentities) {
      const pair = identityPairKey(identity.issuer, identity.subject);
      const ids = candidateIdsByPair.get(pair) ?? [];
      ids.push(fact.accountId);
      candidateIdsByPair.set(pair, ids);
    }
  }
  for (const [pair, ids] of candidateIdsByPair) {
    if (ids.length <= 1) continue;
    for (const accountId of ids) {
      conflicts.set(accountId, {
        accountId,
        reason: 'duplicate_subject',
        detail: `identity (${pair.replace('\u0000', ', ')}) is shared by accounts ${ids.join(', ')}`,
      });
    }
  }

  // Pass 3: per-account classification against the existing auth state.
  const migratable: LegacyAccountFacts[] = [];
  for (const fact of sorted) {
    if (conflicts.has(fact.accountId)) continue;
    if (fact.status !== 'active') {
      skipped.push({
        accountId: fact.accountId,
        reason: 'inactive',
        detail: `status=${fact.status}${fact.deletedAt !== null ? ' (deleted_at set)' : ''}`,
      });
      continue;
    }
    if (fact.email === null || fact.email.length === 0) {
      skipped.push({
        accountId: fact.accountId,
        reason: 'missing_email',
        detail: 'active account has no product email; auth_users.email is NOT NULL',
      });
      continue;
    }

    const mapping = state.mappingsByAccountId.get(fact.accountId);
    if (mapping) {
      const user = state.authUsersById.get(mapping.authUserId);
      if (!user) {
        conflicts.set(fact.accountId, {
          accountId: fact.accountId,
          reason: 'corrupt_mapping',
          detail: `mapping points at missing auth user ${mapping.authUserId}`,
        });
        continue;
      }
      skipped.push({
        accountId: fact.accountId,
        reason: 'already_imported',
        detail: `mapped to auth user ${user.id}`,
      });
      continue;
    }

    const expectedUserId = deriveLegacyAuthUserId(fact.accountId);
    const userByEmail = state.authUsersByEmail.get(fact.email);
    if (userByEmail && userByEmail.id !== expectedUserId) {
      conflicts.set(fact.accountId, {
        accountId: fact.accountId,
        reason: 'duplicate_email',
        detail: `email "${fact.email}" is already held by auth user ${userByEmail.id}; import never merges or adopts by email`,
      });
      continue;
    }

    let conflicted = false;
    for (const identity of fact.oidcIdentities) {
      const pair = identityPairKey(identity.issuer, identity.subject);
      const archive = state.archivesByIssuerSubject.get(pair);
      if (archive && archive.accountId !== fact.accountId) {
        conflicts.set(fact.accountId, {
          accountId: fact.accountId,
          reason: 'duplicate_subject',
          detail: `identity (${identity.issuer}, ${identity.subject}) is already archived for account ${archive.accountId}`,
        });
        conflicted = true;
        break;
      }
    }
    if (!conflicted) migratable.push(fact);
  }

  return {
    migratable,
    skipped,
    conflicts: [...conflicts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)),
  };
}

/** ADR §15 validation queries (B2 runs them before and after apply). */
export interface LegacyImportValidationReport {
  /** Query 1: auth users without a mapping (must be 0 except pending manual recovery). */
  readonly orphanAuthUserIds: readonly string[];
  /** Query 2: mapping rows pointing at a missing auth user (must be 0). */
  readonly orphanMappingAuthUserIds: readonly string[];
  /** Query 3: business accounts with more than one auth user (must be 0). */
  readonly duplicateAccountMappings: readonly { readonly accountId: string; readonly count: number }[];
  /** Query 4: active accounts without profile/handle/mapping coverage. */
  readonly activeAccountsWithoutCoverage: readonly string[];
  /** Query 5: archive columns matching token|secret|code|refresh (must be 0). */
  readonly archiveSecretColumns: readonly string[];
}

/** Transaction-bound write surface for ONE account's import (user + mapping + archive). */
export interface LegacyImportTransactionPorts {
  /**
   * Inserts the auth user. Returns the id when a row was created and null
   * when the deterministic id already existed (idempotent heal).
   */
  insertAuthUser(user: LegacyImportAuthUser): Promise<string | null>;
  /** Inserts the mapping; a unique violation aborts the whole account transaction (fail-closed). */
  insertMapping(mapping: AuthUserAccountMapping): Promise<void>;
  /**
   * Inserts the archive row. Returns true when created and false when the
   * (issuer, subject) pair already existed (pre-flight verified it belongs
   * to this account; the unique constraint is the idempotency surface).
   */
  insertArchive(row: LegacyImportArchiveRow): Promise<boolean>;
}

export interface LegacyImportUnitOfWork {
  execute<Result>(work: (ports: LegacyImportTransactionPorts) => Promise<Result>): Promise<Result>;
}

export interface LegacyImportArchiveRow {
  readonly issuer: string;
  readonly subject: string;
  readonly accountId: string;
  readonly migrationSource: string;
  readonly emailVerifiedClaim: boolean;
  readonly migratedAt: Date;
}

export interface LegacyImportPorts {
  readonly unitOfWork: LegacyImportUnitOfWork;
  readonly clock: { now(): Promise<Date> };
  listAccountFacts(): Promise<readonly LegacyAccountFacts[]>;
  listExistingState(): Promise<LegacyImportExistingState>;
  runValidationQueries(): Promise<LegacyImportValidationReport>;
}

export type LegacyImportOutcome = 'ok' | 'rejected' | 'failed' | 'incomplete';

export interface LegacyImportCounts {
  readonly accountsScanned: number;
  readonly migratable: number;
  readonly imported: number;
  readonly alreadyImported: number;
  readonly skippedMissingEmail: number;
  readonly skippedInactive: number;
  readonly conflicts: number;
  readonly quarantined: number;
  readonly failed: number;
  readonly authUsersCreated: number;
  readonly mappingsCreated: number;
  readonly archiveRowsCreated: number;
}

export interface LegacyImportReport {
  readonly runId: string;
  readonly mode: 'dry-run' | 'apply';
  readonly options: {
    readonly migrationSource: string;
    readonly emailVerifiedClaim: boolean;
    readonly quarantine: boolean;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: LegacyImportOutcome;
  readonly counts: LegacyImportCounts;
  readonly skipped: readonly LegacyImportSkipped[];
  readonly conflicts: readonly LegacyImportConflict[];
  readonly imported: readonly string[];
  readonly failed: readonly { readonly accountId: string; readonly error: string }[];
  readonly validationBefore: LegacyImportValidationReport | null;
  readonly validationAfter: LegacyImportValidationReport | null;
  /** sha256 hex digest over the canonical JSON of the report (digest field excluded). */
  readonly digest: string;
}

export interface LegacyImportRunInput {
  readonly mode: 'dry-run' | 'apply';
}

function buildCounts(
  factsCount: number,
  plan: LegacyImportPlan,
  imported: readonly string[],
  failedCount: number,
  created: { readonly authUsers: number; readonly mappings: number; readonly archiveRows: number },
  quarantine: boolean,
): LegacyImportCounts {
  return {
    accountsScanned: factsCount,
    migratable: plan.migratable.length,
    imported: imported.length,
    alreadyImported: plan.skipped.filter((s) => s.reason === 'already_imported').length,
    skippedMissingEmail: plan.skipped.filter((s) => s.reason === 'missing_email').length,
    skippedInactive: plan.skipped.filter((s) => s.reason === 'inactive').length,
    conflicts: plan.conflicts.length,
    quarantined: quarantine ? plan.conflicts.length : 0,
    failed: failedCount,
    authUsersCreated: created.authUsers,
    mappingsCreated: created.mappings,
    archiveRowsCreated: created.archiveRows,
  };
}

function validationHasHardViolations(report: LegacyImportValidationReport): boolean {
  return report.orphanAuthUserIds.length > 0
    || report.orphanMappingAuthUserIds.length > 0
    || report.duplicateAccountMappings.length > 0
    || report.archiveSecretColumns.length > 0;
}

/**
 * Orchestrates the controlled import: plan → (reject | apply per-account
 * transactions) → ADR §15 validation → digest-bearing report.
 *
 * Default is fail-closed: ANY conflict rejects the whole batch before a
 * single write (outcome `rejected`). With `quarantine: true` conflicts are
 * reported and only the non-conflicting accounts are imported (outcome
 * `incomplete` when the end state still needs review). A runtime failure
 * inside an account transaction stops the batch immediately (outcome
 * `failed`); previously committed accounts stay (resume by re-running).
 */
export async function runLegacyAccountImport(
  ports: LegacyImportPorts,
  options: LegacyImportOptions,
  input: LegacyImportRunInput,
): Promise<LegacyImportReport> {
  const runId = randomUUID();
  const startedAt = new Date();
  const facts = await ports.listAccountFacts();
  const state = await ports.listExistingState();
  const plan = planLegacyAccountImport(facts, state);
  const validationBefore = await ports.runValidationQueries();

  const imported: string[] = [];
  const failed: { accountId: string; error: string }[] = [];
  const created = { authUsers: 0, mappings: 0, archiveRows: 0 };

  let outcome: LegacyImportOutcome;
  let validationAfter: LegacyImportValidationReport | null = null;

  if (plan.conflicts.length > 0 && !options.quarantine) {
    outcome = 'rejected';
  } else if (input.mode === 'apply') {
    for (const fact of plan.migratable) {
      try {
        await ports.unitOfWork.execute(async (tx) => {
          const now = await ports.clock.now();
          const authUserId = deriveLegacyAuthUserId(fact.accountId);
          const createdUser = await tx.insertAuthUser({
            id: authUserId,
            name: deriveLegacyAuthUserName(fact),
            email: fact.email as string,
          });
          if (createdUser !== null) created.authUsers += 1;
          const mapping: AuthUserAccountMapping = {
            authUserId,
            accountId: fact.accountId,
            createdAt: now,
          };
          await tx.insertMapping(mapping);
          created.mappings += 1;
          for (const identity of fact.oidcIdentities) {
            const archived = await tx.insertArchive({
              issuer: identity.issuer,
              subject: identity.subject,
              accountId: fact.accountId,
              migrationSource: options.migrationSource,
              emailVerifiedClaim: options.emailVerifiedClaim,
              migratedAt: now,
            });
            if (archived) created.archiveRows += 1;
          }
        });
        imported.push(fact.accountId);
      } catch (error) {
        failed.push({
          accountId: fact.accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    validationAfter = await ports.runValidationQueries();
    if (failed.length > 0) {
      outcome = 'failed';
    } else if (validationHasHardViolations(validationAfter)) {
      outcome = 'failed';
    } else if (
      validationAfter.activeAccountsWithoutCoverage.length > 0
      || (options.quarantine && plan.conflicts.length > 0)
    ) {
      outcome = 'incomplete';
    } else {
      outcome = 'ok';
    }
  } else {
    outcome = plan.conflicts.length > 0
      ? (options.quarantine ? 'incomplete' : 'rejected')
      : 'ok';
  }

  const report: LegacyImportReport & { digest: string } = {
    runId,
    mode: input.mode,
    options: {
      migrationSource: options.migrationSource,
      emailVerifiedClaim: options.emailVerifiedClaim,
      quarantine: options.quarantine,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outcome,
    counts: buildCounts(facts.length, plan, imported, failed.length, created, options.quarantine),
    skipped: plan.skipped,
    conflicts: plan.conflicts,
    imported,
    failed,
    validationBefore,
    validationAfter,
    digest: '',
  };
  // The digest is computed over the canonical JSON with the digest field
  // excluded (computeLegacyImportDigest), so the ledger-tamper invariant is
  // unchanged; the local intersection type keeps the field writable here.
  report.digest = computeLegacyImportDigest(report);
  return report;
}

/**
 * sha256 hex digest over the canonical JSON of the report with the digest
 * field excluded. Stable for identical reports; any content change rotates
 * the digest (ledger tamper evidence).
 */
export function computeLegacyImportDigest(report: LegacyImportReport): string {
  const canonical = JSON.stringify({ ...report, digest: undefined });
  return createHash('sha256').update(canonical).digest('hex');
}
