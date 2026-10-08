/**
 * Task B2 unit tests: legacy OIDC account import planning + orchestration
 * over in-memory ports (pure application logic, no database).
 *
 * Production surface:
 *   planLegacyAccountImport(facts, state) → LegacyImportPlan
 *   runLegacyAccountImport(ports, options, { mode }) → LegacyImportReport
 *   deriveLegacyAuthUserId / deriveLegacyAuthUserName / computeLegacyImportDigest
 *
 * 假阴性防护: the in-memory unit of work snapshots its state before each
 * account transaction and restores it on failure, so rollback semantics are
 * exercised without a database; the planner is fed facts in shuffled order
 * and must produce the identical plan (order independence).
 *
 * 假阳性防护: the orchestrator must never invoke the write surface for a
 * conflicting account (no first-wins), must never merge two accounts that
 * share an email (both conflict), must never create a password credential or
 * session (the write surface only knows user/mapping/archive), and repeated
 * runs must not mint duplicate rows.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEFAULT_LEGACY_IMPORT_OPTIONS,
  LEGACY_AUTH_USER_ID_PREFIX,
  computeLegacyImportDigest,
  deriveLegacyAuthUserId,
  deriveLegacyAuthUserName,
  planLegacyAccountImport,
  runLegacyAccountImport,
  type LegacyAccountFacts,
  type LegacyImportArchiveRow,
  type LegacyImportAuthUser,
  type LegacyImportExistingState,
  type LegacyImportOptions,
  type LegacyImportPorts,
  type LegacyImportReport,
  type LegacyImportTransactionPorts,
  type LegacyImportUnitOfWork,
  type LegacyImportValidationReport,
} from '../../../src/modules/auth/application/legacy-account-import.js';
import type { AuthUserAccountMapping } from '../../../src/modules/identity/index.js';

const NOW = new Date('2026-09-05T12:00:00.000Z');

interface MemoryRow {
  readonly authUserId: string;
  readonly accountId: string;
  readonly createdAt: Date;
}

interface MemoryArchiveRow {
  readonly issuer: string;
  readonly subject: string;
  readonly accountId: string;
  readonly migrationSource: string;
  readonly emailVerifiedClaim: boolean;
  readonly migratedAt: Date;
}

interface MemoryUserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

class MemoryLegacyImportBackend {
  facts: readonly LegacyAccountFacts[] = [];
  users = new Map<string, MemoryUserRow>();
  mappings = new Map<string, MemoryRow>();
  archives = new Map<string, MemoryArchiveRow>();
  profilesByAccount = new Set<string>();
  handlesByAccount = new Set<string>();

  /** Fail the N-th unit-of-work execute() call (1-based); 0 = never. */
  failOnCall = 0;
  unitOfWorkCalls = 0;

  seedFact(fact: LegacyAccountFacts): void {
    this.facts = [...this.facts, fact];
    if (fact.displayName !== null) this.profilesByAccount.add(fact.accountId);
    this.handlesByAccount.add(fact.accountId);
  }

  seedAuthUser(id: string, email: string): void {
    this.users.set(id, { id, name: `name-${id}`, email });
  }

  seedMapping(authUserId: string, accountId: string): void {
    this.mappings.set(accountId, { authUserId, accountId, createdAt: NOW });
  }

  seedArchive(issuer: string, subject: string, accountId: string): void {
    this.archives.set(`${issuer}\u0000${subject}`, {
      issuer,
      subject,
      accountId,
      migrationSource: 'legacy-oidc-import-v1',
      emailVerifiedClaim: false,
      migratedAt: NOW,
    });
  }

  ports(): LegacyImportPorts {
    const backend = this;
    const unitOfWork: LegacyImportUnitOfWork = {
      async execute<Result>(work: (ports: LegacyImportTransactionPorts) => Promise<Result>): Promise<Result> {
        backend.unitOfWorkCalls += 1;
        if (backend.failOnCall > 0 && backend.unitOfWorkCalls === backend.failOnCall) {
          throw new Error('injected unit-of-work failure');
        }
        const usersSnapshot = new Map(backend.users);
        const mappingsSnapshot = new Map(backend.mappings);
        const archivesSnapshot = new Map(backend.archives);
        try {
          return await work({
            async insertAuthUser(user) {
              if (backend.users.has(user.id)) return null;
              backend.users.set(user.id, user);
              return user.id;
            },
            async insertMapping(mapping) {
              if (backend.mappings.has(mapping.accountId)) {
                throw new Error('duplicate mapping (unique violation)');
              }
              backend.mappings.set(mapping.accountId, mapping);
            },
            async insertArchive(row) {
              const key = `${row.issuer}\u0000${row.subject}`;
              if (backend.archives.has(key)) return false;
              backend.archives.set(key, row);
              return true;
            },
          });
        } catch (error) {
          backend.users = new Map(usersSnapshot);
          backend.mappings = new Map(mappingsSnapshot);
          backend.archives = new Map(archivesSnapshot);
          throw error;
        }
      },
    };
    return {
      unitOfWork,
      clock: { now: async () => NOW },
      listAccountFacts: async () => [...backend.facts],
      listExistingState: async () => buildExistingState(backend),
      runValidationQueries: async () => buildValidationReport(backend),
    };
  }
}

function buildExistingState(backend: MemoryLegacyImportBackend): LegacyImportExistingState {
  const authUsersByEmail = new Map<string, LegacyImportAuthUser>();
  const authUsersById = new Map<string, LegacyImportAuthUser>();
  for (const user of backend.users.values()) {
    authUsersByEmail.set(user.email, { id: user.id, name: user.name, email: user.email });
    authUsersById.set(user.id, { id: user.id, name: user.name, email: user.email });
  }
  const mappingsByAccountId = new Map<string, { authUserId: string; accountId: string }>();
  for (const mapping of backend.mappings.values()) {
    mappingsByAccountId.set(mapping.accountId, { authUserId: mapping.authUserId, accountId: mapping.accountId });
  }
  const archivesByIssuerSubject = new Map<string, { issuer: string; subject: string; accountId: string }>();
  for (const archive of backend.archives.values()) {
    archivesByIssuerSubject.set(`${archive.issuer}\u0000${archive.subject}`, {
      issuer: archive.issuer,
      subject: archive.subject,
      accountId: archive.accountId,
    });
  }
  return { authUsersByEmail, authUsersById, mappingsByAccountId, archivesByIssuerSubject };
}

function buildValidationReport(backend: MemoryLegacyImportBackend): LegacyImportValidationReport {
  const mappedUserIds = new Set([...backend.mappings.values()].map((m) => m.authUserId));
  const knownUserIds = new Set(backend.users.keys());
  const orphanAuthUserIds = [...backend.users.keys()]
    .filter((id) => !mappedUserIds.has(id))
    .sort();
  const orphanMappingAuthUserIds = [...backend.mappings.values()]
    .map((m) => m.authUserId)
    .filter((id) => !knownUserIds.has(id))
    .sort();
  const accountCounts = new Map<string, number>();
  for (const mapping of backend.mappings.values()) {
    accountCounts.set(mapping.accountId, (accountCounts.get(mapping.accountId) ?? 0) + 1);
  }
  const duplicateAccountMappings = [...accountCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([accountId, count]) => ({ accountId, count }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  const activeAccountsWithoutCoverage = backend.facts
    .filter((fact) => fact.status === 'active')
    .filter((fact) => !backend.mappings.has(fact.accountId)
      || !backend.profilesByAccount.has(fact.accountId)
      || !backend.handlesByAccount.has(fact.accountId))
    .map((fact) => fact.accountId)
    .sort();
  return {
    orphanAuthUserIds,
    orphanMappingAuthUserIds,
    duplicateAccountMappings,
    activeAccountsWithoutCoverage,
    archiveSecretColumns: [],
  };
}

function demoFact(accountId: string, email: string, subject: string): LegacyAccountFacts {
  return {
    accountId,
    email,
    status: 'active',
    deletedAt: null,
    displayName: `User ${accountId}`,
    oidcIdentities: [{ issuer: 'https://accounts.example.com', subject }],
  };
}

/** 15 demo-like accounts mirroring seed/demo/data.sql structure. */
function demoFacts(count = 15): LegacyAccountFacts[] {
  const facts: LegacyAccountFacts[] = [];
  for (let index = 1; index <= count; index += 1) {
    const number = String(index).padStart(2, '0');
    facts.push(demoFact(`acc-u${number}`, `user${number}@example.com`, `sub-u${number}`));
  }
  return facts;
}

function shuffled<T>(values: readonly T[]): T[] {
  return [...values].sort(() => (Math.random() < 0.5 ? -1 : 1));
}

function options(overrides: Partial<LegacyImportOptions> = {}): LegacyImportOptions {
  return { ...DEFAULT_LEGACY_IMPORT_OPTIONS, ...overrides };
}

describe('B2 legacy account import planner', () => {
  test('15+ demo-like accounts are all migratable in deterministic account-id order', () => {
    const facts = demoFacts(15);
    const plan = planLegacyAccountImport(shuffled(facts), buildExistingState(new MemoryLegacyImportBackend()));
    assert.equal(plan.migratable.length, 15);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.skipped.length, 0);
    assert.deepEqual(
      plan.migratable.map((fact) => fact.accountId),
      [...facts].map((fact) => fact.accountId).sort(),
      'plan order must be sorted by account id regardless of input order',
    );
  });

  test('active accounts without email are skipped with missing_email', () => {
    const facts = [demoFact('acc-a', 'a@example.com', 'sub-a'), { ...demoFact('acc-b', 'b@example.com', 'sub-b'), email: null }];
    const plan = planLegacyAccountImport(facts, buildExistingState(new MemoryLegacyImportBackend()));
    assert.equal(plan.migratable.length, 1);
    assert.equal(plan.migratable[0]!.accountId, 'acc-a');
    assert.deepEqual(plan.skipped, [{
      accountId: 'acc-b',
      reason: 'missing_email',
      detail: 'active account has no product email; auth_users.email is NOT NULL',
    }]);
  });

  test('disabled and deleted accounts are skipped with their status', () => {
    const facts = [
      demoFact('acc-a', 'a@example.com', 'sub-a'),
      { ...demoFact('acc-disabled', 'disabled@example.com', 'sub-disabled'), status: 'disabled' as const },
      { ...demoFact('acc-deleted', 'deleted@example.com', 'sub-deleted'), status: 'deleted' as const, deletedAt: NOW },
    ];
    const plan = planLegacyAccountImport(facts, buildExistingState(new MemoryLegacyImportBackend()));
    assert.equal(plan.migratable.length, 1);
    assert.deepEqual(plan.skipped.map((s) => [s.accountId, s.reason]), [
      ['acc-deleted', 'inactive'],
      ['acc-disabled', 'inactive'],
    ]);
    assert.match(plan.skipped[0]!.detail, /status=deleted.*deleted_at set/);
    assert.match(plan.skipped[1]!.detail, /status=disabled/);
  });

  test('an email shared by two candidate accounts conflicts BOTH (never first-wins)', () => {
    const facts = [
      demoFact('acc-a', 'shared@example.com', 'sub-a'),
      demoFact('acc-b', 'shared@example.com', 'sub-b'),
      demoFact('acc-c', 'c@example.com', 'sub-c'),
    ];
    const plan = planLegacyAccountImport(facts, buildExistingState(new MemoryLegacyImportBackend()));
    assert.equal(plan.migratable.length, 1);
    assert.equal(plan.migratable[0]!.accountId, 'acc-c');
    assert.deepEqual(plan.conflicts.map((c) => [c.accountId, c.reason]), [
      ['acc-a', 'duplicate_email'],
      ['acc-b', 'duplicate_email'],
    ]);
  });

  test('an (issuer, subject) pair shared by two candidates conflicts BOTH accounts', () => {
    const facts = [
      { ...demoFact('acc-a', 'a@example.com', 'sub-a'), oidcIdentities: [{ issuer: 'https://idp.example', subject: 'same-subject' }] },
      { ...demoFact('acc-b', 'b@example.com', 'sub-b'), oidcIdentities: [{ issuer: 'https://idp.example', subject: 'same-subject' }] },
    ];
    const plan = planLegacyAccountImport(facts, buildExistingState(new MemoryLegacyImportBackend()));
    assert.equal(plan.migratable.length, 0);
    assert.deepEqual(plan.conflicts.map((c) => [c.accountId, c.reason]), [
      ['acc-a', 'duplicate_subject'],
      ['acc-b', 'duplicate_subject'],
    ]);
  });

  test('an already-mapped account is skipped as already_imported; corrupt mapping conflicts', () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedAuthUser(deriveLegacyAuthUserId('acc-a'), 'a@example.com');
    backend.seedMapping(deriveLegacyAuthUserId('acc-a'), 'acc-a');
    const plan = planLegacyAccountImport([demoFact('acc-a', 'a@example.com', 'sub-a')], buildExistingState(backend));
    assert.deepEqual(plan.skipped.map((s) => [s.accountId, s.reason]), [['acc-a', 'already_imported']]);
    assert.equal(plan.migratable.length, 0);

    const corrupt = new MemoryLegacyImportBackend();
    corrupt.seedMapping('missing-user', 'acc-b');
    const corruptPlan = planLegacyAccountImport([demoFact('acc-b', 'b@example.com', 'sub-b')], buildExistingState(corrupt));
    assert.deepEqual(corruptPlan.conflicts.map((c) => [c.accountId, c.reason]), [['acc-b', 'corrupt_mapping']]);
  });

  test('an email held by a DIFFERENT auth user is a conflict; our deterministic id is the heal path', () => {
    const other = new MemoryLegacyImportBackend();
    other.seedAuthUser('external-user', 'a@example.com');
    const otherPlan = planLegacyAccountImport([demoFact('acc-a', 'a@example.com', 'sub-a')], buildExistingState(other));
    assert.deepEqual(otherPlan.conflicts.map((c) => [c.accountId, c.reason]), [['acc-a', 'duplicate_email']]);
    assert.match(otherPlan.conflicts[0]!.detail, /never merges or adopts by email/);

    const heal = new MemoryLegacyImportBackend();
    heal.seedAuthUser(deriveLegacyAuthUserId('acc-a'), 'a@example.com');
    const healPlan = planLegacyAccountImport([demoFact('acc-a', 'a@example.com', 'sub-a')], buildExistingState(heal));
    assert.equal(healPlan.migratable.length, 1);
    assert.equal(healPlan.conflicts.length, 0);
  });

  test('an (issuer, subject) already archived for another account conflicts; same account is healable', () => {
    const other = new MemoryLegacyImportBackend();
    other.seedArchive('https://accounts.example.com', 'sub-a', 'acc-other');
    const otherPlan = planLegacyAccountImport([demoFact('acc-a', 'a@example.com', 'sub-a')], buildExistingState(other));
    assert.deepEqual(otherPlan.conflicts.map((c) => [c.accountId, c.reason]), [['acc-a', 'duplicate_subject']]);

    const heal = new MemoryLegacyImportBackend();
    heal.seedArchive('https://accounts.example.com', 'sub-a', 'acc-a');
    const healPlan = planLegacyAccountImport([demoFact('acc-a', 'a@example.com', 'sub-a')], buildExistingState(heal));
    assert.equal(healPlan.migratable.length, 1);
  });
});

describe('B2 legacy account import orchestration', () => {
  test('dry-run writes nothing and reports the full plan', async () => {
    const backend = new MemoryLegacyImportBackend();
    for (const fact of demoFacts(15)) backend.seedFact(fact);
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'dry-run' });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.accountsScanned, 15);
    assert.equal(report.counts.migratable, 15);
    assert.equal(report.counts.imported, 0);
    assert.equal(backend.users.size, 0);
    assert.equal(backend.mappings.size, 0);
    assert.equal(backend.archives.size, 0);
    assert.equal(report.validationAfter, null);
    assert.match(report.digest, /^[0-9a-f]{64}$/u);
  });

  test('apply imports 15+ demo-like accounts with user/mapping/archive only (no credentials or sessions)', async () => {
    const backend = new MemoryLegacyImportBackend();
    for (const fact of demoFacts(15)) backend.seedFact(fact);
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.imported, 15);
    assert.equal(report.counts.authUsersCreated, 15);
    assert.equal(report.counts.mappingsCreated, 15);
    assert.equal(report.counts.archiveRowsCreated, 15);
    assert.equal(backend.users.size, 15);
    assert.equal(backend.mappings.size, 15);
    assert.equal(backend.archives.size, 15);
    assert.equal(report.validationAfter!.orphanAuthUserIds.length, 0);
    assert.equal(report.validationAfter!.activeAccountsWithoutCoverage.length, 0);

    for (const fact of demoFacts(15)) {
      const user = backend.users.get(deriveLegacyAuthUserId(fact.accountId));
      assert.ok(user, `auth user for ${fact.accountId} must exist`);
      assert.equal(user!.email, fact.email);
      assert.equal(user!.name, fact.displayName);
      const mapping = backend.mappings.get(fact.accountId);
      assert.ok(mapping, `mapping for ${fact.accountId} must exist`);
      assert.equal(mapping!.authUserId, user!.id);
      const archive = backend.archives.get(`${fact.oidcIdentities[0]!.issuer}\u0000${fact.oidcIdentities[0]!.subject}`);
      assert.ok(archive, `archive row for ${fact.accountId} must exist`);
      assert.equal(archive!.accountId, fact.accountId);
    }
  });

  test('conflicts reject the whole batch by default and quarantine with quarantine: true', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'shared@example.com', 'sub-a'));
    backend.seedFact(demoFact('acc-b', 'shared@example.com', 'sub-b'));
    backend.seedFact(demoFact('acc-c', 'c@example.com', 'sub-c'));

    const rejected = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.counts.conflicts, 2);
    assert.equal(rejected.counts.imported, 0);
    assert.equal(backend.users.size, 0, 'fail-closed: no account may be written when the batch is rejected');
    assert.equal(backend.mappings.size, 0);
    assert.equal(backend.archives.size, 0);

    const quarantined = await runLegacyAccountImport(backend.ports(), options({ quarantine: true }), { mode: 'apply' });
    assert.equal(quarantined.outcome, 'incomplete');
    assert.equal(quarantined.counts.quarantined, 2);
    assert.deepEqual(quarantined.imported, ['acc-c']);
    assert.equal(backend.users.size, 1, 'only the non-conflicting account may be imported');
    assert.ok(backend.mappings.has('acc-c'));
    assert.ok(!backend.mappings.has('acc-a') && !backend.mappings.has('acc-b'), 'conflicting accounts stay unmapped');
  });

  test('apply is idempotent: a second run imports nothing and mints no duplicates', async () => {
    const backend = new MemoryLegacyImportBackend();
    for (const fact of demoFacts(15)) backend.seedFact(fact);
    const first = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(first.outcome, 'ok');
    const second = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(second.outcome, 'ok');
    assert.equal(second.counts.imported, 0);
    assert.equal(second.counts.alreadyImported, 15);
    assert.equal(second.counts.authUsersCreated, 0);
    assert.equal(second.counts.mappingsCreated, 0);
    assert.equal(second.counts.archiveRowsCreated, 0);
    assert.equal(backend.users.size, 15);
    assert.equal(backend.mappings.size, 15);
    assert.equal(backend.archives.size, 15);
  });

  test('a runtime failure mid-batch stops the batch, rolls the failing account back, and the next run resumes', async () => {
    const backend = new MemoryLegacyImportBackend();
    for (const fact of demoFacts(5)) backend.seedFact(fact);
    backend.failOnCall = 4;
    const failed = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.counts.imported, 3, 'accounts 1..3 committed before the failure');
    assert.equal(failed.counts.failed, 1);
    assert.equal(backend.users.size, 3, 'the failing account transaction must roll back completely');
    assert.equal(backend.mappings.size, 3);
    assert.equal(backend.archives.size, 3);

    backend.failOnCall = 0;
    const resumed = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(resumed.outcome, 'ok');
    assert.equal(resumed.counts.imported, 2, 'the remaining accounts are imported on resume');
    assert.equal(resumed.counts.alreadyImported, 3);
    assert.equal(backend.users.size, 5);
    assert.equal(backend.mappings.size, 5);
    assert.equal(backend.archives.size, 5);
  });

  test('an account whose transaction fails leaves zero half-written rows (rollback)', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'a@example.com', 'sub-a'));
    backend.seedFact(demoFact('acc-b', 'b@example.com', 'sub-b'));
    backend.failOnCall = 1;
    const failed = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(failed.outcome, 'failed');
    assert.equal(backend.users.size, 0);
    assert.equal(backend.mappings.size, 0);
    assert.equal(backend.archives.size, 0);
  });

  test('pre-existing orphan auth users are reported by validation (fail-closed outcome)', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'a@example.com', 'sub-a'));
    backend.seedAuthUser('orphan-user', 'orphan@example.com');
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(report.outcome, 'failed');
    assert.deepEqual(report.validationAfter!.orphanAuthUserIds, ['orphan-user']);
    assert.equal(report.counts.imported, 1, 'per-account progress is preserved; the invariant violation needs review');
  });

  test('incomplete coverage (missing email account) yields an incomplete outcome with evidence', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'a@example.com', 'sub-a'));
    backend.seedFact({ ...demoFact('acc-b', 'b@example.com', 'sub-b'), email: null });
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(report.outcome, 'incomplete');
    assert.deepEqual(report.validationAfter!.activeAccountsWithoutCoverage, ['acc-b']);
    assert.equal(report.counts.skippedMissingEmail, 1);
  });

  test('the report digest is self-consistent and rotates on any content change', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'a@example.com', 'sub-a'));
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'dry-run' });
    assert.match(report.digest, /^[0-9a-f]{64}$/u);
    assert.equal(
      computeLegacyImportDigest(report),
      report.digest,
      'the digest must be reproducible from the report content',
    );
    assert.notEqual(
      computeLegacyImportDigest({ ...report, counts: { ...report.counts, conflicts: 1 } }),
      report.digest,
      'any content change must rotate the digest',
    );
  });

  test('deterministic auth user id and name derivation', () => {
    assert.equal(deriveLegacyAuthUserId('acc-u01'), `${LEGACY_AUTH_USER_ID_PREFIX}:acc-u01`);
    assert.equal(deriveLegacyAuthUserName(demoFact('acc-a', 'a@example.com', 'sub-a')), 'User acc-a');
    assert.equal(
      deriveLegacyAuthUserName({ ...demoFact('acc-b', 'b@example.com', 'sub-b'), displayName: '  ' }),
      'b',
      'falls back to the email local part',
    );
    assert.equal(
      deriveLegacyAuthUserName({ ...demoFact('acc-c', 'c@example.com', 'sub-c'), displayName: null, email: null }),
      'acc-c',
      'falls back to the account id',
    );
  });

  test('apply heals a deterministic-id auth user whose mapping was removed', async () => {
    const backend = new MemoryLegacyImportBackend();
    backend.seedFact(demoFact('acc-a', 'a@example.com', 'sub-a'));
    backend.seedAuthUser(deriveLegacyAuthUserId('acc-a'), 'a@example.com');
    const report = await runLegacyAccountImport(backend.ports(), options(), { mode: 'apply' });
    assert.equal(report.outcome, 'ok');
    assert.equal(report.counts.authUsersCreated, 0, 'the existing deterministic user is reused');
    assert.equal(report.counts.mappingsCreated, 1);
    assert.ok(backend.mappings.has('acc-a'));
  });

  test('report shape is fully serializable and carries mode/options/counts/validation', async () => {
    const backend = new MemoryLegacyImportBackend();
    for (const fact of demoFacts(15)) backend.seedFact(fact);
    const report = await runLegacyAccountImport(
      backend.ports(),
      options({ migrationSource: 'ops-run-2026', emailVerifiedClaim: true }),
      { mode: 'apply' },
    );
    const serialized: LegacyImportReport = JSON.parse(JSON.stringify(report));
    assert.equal(serialized.mode, 'apply');
    assert.equal(serialized.options.migrationSource, 'ops-run-2026');
    assert.equal(serialized.options.emailVerifiedClaim, true);
    assert.equal(serialized.counts.accountsScanned, 15);
    assert.equal(serialized.digest, report.digest);
  });
});
