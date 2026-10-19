import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { ensureExtensionAccountIdentity } from '../../../src/modules/identity/application/ensure-extension-account-identity.js';
import {
  ExtensionAuthError,
  type AccountIdentity,
} from '../../../src/modules/identity/index.js';

const ISSUER = 'https://known.example';
const OTHER_ISSUER = 'https://other.example';
const NOW = new Date('2026-10-10T00:00:00.000Z');

function identity(
  id: string,
  accountId: string,
  issuer = ISSUER,
  subject = `sub-${accountId}`,
): AccountIdentity {
  return { id, accountId, issuer, subject, createdAt: NOW };
}

interface FakeRepository {
  readonly calls: { pair: number; account: number; insert: number };
  readonly rows: Map<string, AccountIdentity>;
  findByIssuerSubject(issuer: string, subject: string): Promise<AccountIdentity | null>;
  findByAccountId(accountId: string): Promise<AccountIdentity | null>;
  insert(row: AccountIdentity): Promise<void>;
  insertIfAbsent(row: AccountIdentity): Promise<AccountIdentity>;
}

function createRepository(options: {
  readonly rows?: readonly AccountIdentity[];
  readonly onInsert?: (repository: FakeRepository, row: AccountIdentity) => void | Promise<void>;
} = {}): FakeRepository {
  const rows = new Map<string, AccountIdentity>();
  const key = (issuer: string, subject: string) => `${issuer}\0${subject}`;
  for (const row of options.rows ?? []) rows.set(key(row.issuer, row.subject), row);
  const calls = { pair: 0, account: 0, insert: 0 };
  const repository: FakeRepository = {
    calls,
    rows,
    async findByIssuerSubject(issuer, subject) {
      calls.pair += 1;
      return rows.get(key(issuer, subject)) ?? null;
    },
    async findByAccountId(accountId) {
      calls.account += 1;
      for (const row of rows.values()) {
        if (row.accountId === accountId) return row;
      }
      return null;
    },
    async insert(row) {
      calls.insert += 1;
      await options.onInsert?.(repository, row);
      rows.set(key(row.issuer, row.subject), row);
    },
    async insertIfAbsent(row) {
      const existing = rows.get(key(row.issuer, row.subject));
      if (existing) return existing;
      rows.set(key(row.issuer, row.subject), row);
      return row;
    },
  };
  return repository;
}

function uniqueViolation(constraint: string, message = 'duplicate key value violates unique constraint'): Error {
  return Object.assign(new Error(`${message} "${constraint}"`), { code: '23505', constraint });
}

const input = { accountId: 'account-a', subjectId: 'sub-account-a', issuer: ISSUER };

describe('ensureExtensionAccountIdentity database-error handling', () => {
  test('a recognized unique race converges on the winner row after a successful re-read', async () => {
    const winner = identity('identity-winner', input.accountId);
    const repository = createRepository({
      async onInsert(repo, row) {
        // The concurrent winner commits between our lookups and our insert.
        repo.rows.set(`${row.issuer}\0${row.subject}`, winner);
        throw uniqueViolation('account_identities_issuer_subject_unique');
      },
    });

    const binding = await ensureExtensionAccountIdentity(repository, input);

    assert.deepEqual(binding, { issuer: ISSUER, subject: input.subjectId });
    assert.equal(repository.calls.pair, 1);
    assert.equal(repository.calls.account, 2);
    assert.equal(repository.calls.insert, 1);
  });

  test('the wrapped DatabaseOperationError unique kind is recognized structurally', async () => {
    const stored = identity('identity-stored', input.accountId, OTHER_ISSUER, 'sub-stored');
    const cause = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'account_identities_account_id_unique',
    });
    const repository = createRepository({
      async onInsert(repo) {
        repo.rows.set(`${stored.issuer}\0${stored.subject}`, stored);
        throw new DatabaseOperationError('unique_violation', cause);
      },
    });

    const binding = await ensureExtensionAccountIdentity(repository, input);

    // Account-scoped race recovery reuses the stored binding.
    assert.deepEqual(binding, { issuer: OTHER_ISSUER, subject: 'sub-stored' });
    assert.equal(repository.calls.pair, 1);
    assert.equal(repository.calls.account, 2);
  });

  test('a race resolving to another account is invalid_token', async () => {
    const other = identity('identity-other', 'account-b', ISSUER, input.subjectId);
    const repository = createRepository({
      async onInsert(repo) {
        repo.rows.set(`${other.issuer}\0${other.subject}`, other);
        throw uniqueViolation('account_identities_issuer_subject_unique');
      },
    });

    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );
    assert.equal(repository.calls.pair, 2);
    assert.equal(repository.calls.account, 2);
  });

  test('an unresolved true conflict is invalid_token', async () => {
    const repository = createRepository({
      async onInsert() {
        throw uniqueViolation('account_identities_issuer_subject_unique');
      },
    });

    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );
    assert.equal(repository.calls.pair, 2);
    assert.equal(repository.calls.account, 2);
  });

  test('a connection failure propagates as the original error, not invalid_token', async () => {
    const failure = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
    const repository = createRepository({
      async onInsert() {
        throw failure;
      },
    });

    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => {
        assert.equal(error, failure);
        assert.equal(error instanceof ExtensionAuthError, false);
        return true;
      },
    );
    // No race recovery reads after an unrecognized failure.
    assert.equal(repository.calls.pair, 1);
    assert.equal(repository.calls.account, 1);
  });

  test('a wrapped unavailable failure keeps the DatabaseOperationError and its cause', async () => {
    const cause = Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
    const failure = new DatabaseOperationError('unavailable', cause);
    const repository = createRepository({
      async onInsert() {
        throw failure;
      },
    });

    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => {
        assert.equal(error, failure);
        assert.ok(error instanceof DatabaseOperationError);
        assert.equal(error.kind, 'unavailable');
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.equal(repository.calls.pair, 1);
    assert.equal(repository.calls.account, 1);
  });

  test('the composite binding constraint is also recognized as a recoverable race', async () => {
    const winner = identity('identity-composite', input.accountId);
    const repository = createRepository({
      async onInsert(repo, row) {
        repo.rows.set(`${row.issuer}\0${row.subject}`, winner);
        throw uniqueViolation('account_identities_issuer_subject_account_unique');
      },
    });

    const binding = await ensureExtensionAccountIdentity(repository, input);

    assert.deepEqual(binding, { issuer: ISSUER, subject: input.subjectId });
    assert.equal(repository.calls.account, 2);
  });

  test('an unrelated unique violation is never retried as a binding race', async () => {
    for (const constraint of ['accounts_email_unique', 'accounts_pkey', 'account_identities_pkey']) {
      const failure = uniqueViolation(constraint);
      const repository = createRepository({
        async onInsert() {
          throw failure;
        },
      });
      await assert.rejects(
        () => ensureExtensionAccountIdentity(repository, input),
        (error: unknown) => {
          assert.equal(error, failure, `${constraint} must propagate unchanged`);
          return true;
        },
      );
      assert.equal(repository.calls.pair, 1, `${constraint} must not trigger a re-read`);
      assert.equal(repository.calls.account, 1, `${constraint} must not trigger a re-read`);
    }
  });

  test('a unique violation without a constraint name is not treated as a binding race', async () => {
    const failure = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const repository = createRepository({
      async onInsert() {
        throw failure;
      },
    });
    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => error === failure,
    );
    assert.equal(repository.calls.pair, 1);
    assert.equal(repository.calls.account, 1);
  });
});

describe('ensureExtensionAccountIdentity credential semantics', () => {
  test('a pair owned by another account is invalid_token without inserting', async () => {
    const repository = createRepository({
      rows: [identity('identity-b', 'account-b', ISSUER, input.subjectId)],
    });
    await assert.rejects(
      () => ensureExtensionAccountIdentity(repository, input),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
    );
    assert.equal(repository.calls.insert, 0);
  });

  test('an account already bound reuses the stored issuer/subject', async () => {
    const stored = identity('identity-stored', input.accountId, OTHER_ISSUER, 'sub-stored');
    const repository = createRepository({ rows: [stored] });

    const binding = await ensureExtensionAccountIdentity(repository, input);

    assert.deepEqual(binding, { issuer: OTHER_ISSUER, subject: 'sub-stored' });
    assert.equal(repository.calls.insert, 0);
  });

  test('a fresh binding is inserted when both lookups miss', async () => {
    const repository = createRepository();
    const binding = await ensureExtensionAccountIdentity(repository, input, {
      generateId: () => 'generated-id',
      now: () => NOW,
    });
    assert.deepEqual(binding, { issuer: ISSUER, subject: input.subjectId });
    const stored = repository.rows.get(`${ISSUER}\0${input.subjectId}`);
    assert.deepEqual(stored, {
      id: 'generated-id',
      accountId: input.accountId,
      issuer: ISSUER,
      subject: input.subjectId,
      createdAt: NOW,
    });
  });
});
