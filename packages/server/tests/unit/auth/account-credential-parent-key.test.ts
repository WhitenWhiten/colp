import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AccountCredentialCommandError,
  authenticateParentKey,
  hashAccountCredentialSecret,
  issueAccountCredentialSecret,
} from '../../../src/modules/auth/index.js';
import type {
  AccountCredentialAccountPorts,
  AccountCredentialClock,
  AccountCredentialRecord,
  AccountCredentialStore,
} from '../../../src/modules/auth/index.js';
import type { Account } from '../../../src/modules/identity/index.js';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const issued = issueAccountCredentialSecret('parent');

function parentRecord(overrides: Partial<AccountCredentialRecord> = {}): AccountCredentialRecord {
  return {
    id: 'parent-1',
    kind: 'parent',
    parentId: null,
    accountId: 'manager-1',
    subjectId: 'subject-1',
    managerAccountId: 'manager-1',
    label: 'pk',
    prefix: issued.prefix,
    secretHash: issued.secretHash,
    state: 'active',
    revision: 1n,
    epoch: 1n,
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    lastUsedAt: null,
    revokedAt: null,
    revokeReason: null,
    mcpClientId: issued.mcpClientId,
    ...overrides,
  };
}

function managerAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'manager-1',
    subjectId: 'subject-1',
    status: 'active',
    email: null,
    securityEpoch: 1n,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function portsFor(input: {
  readonly account?: Account | null;
  readonly record?: AccountCredentialRecord | null;
}): {
  ports: {
    readonly credentials: AccountCredentialStore;
    readonly clock: AccountCredentialClock;
    readonly accounts: AccountCredentialAccountPorts;
  };
  calls: { touchLastUsed: number };
} {
  const record = input.record === undefined ? parentRecord() : input.record;
  const calls = { touchLastUsed: 0 };
  return {
    calls,
    ports: {
      clock: { now: async () => NOW },
      credentials: {
        findBySecretHash: async (secretHash) => {
          if (!record || secretHash !== hashAccountCredentialSecret(issued.secret)) return null;
          return record;
        },
        touchLastUsed: async () => {
          calls.touchLastUsed += 1;
        },
      } as AccountCredentialStore,
      accounts: {
        findAccountById: async (id) => {
          if (input.account === undefined) {
            return id === 'manager-1' ? managerAccount() : null;
          }
          if (input.account === null) return null;
          return input.account.id === id ? input.account : null;
        },
      } as AccountCredentialAccountPorts,
    },
  };
}

function isInvalidParent(error: unknown): boolean {
  return error instanceof AccountCredentialCommandError
    && error.code === 'invalid_request'
    && error.message === 'The parent credential is invalid.';
}

test('authenticateParentKey returns the parent actor when the manager account is active', async () => {
  const { ports, calls } = portsFor({});
  const actor = await authenticateParentKey(ports, issued.secret);
  assert.equal(actor.accountId, 'manager-1');
  assert.equal(actor.subjectId, 'subject-1');
  assert.equal(actor.managerAccountId, 'manager-1');
  assert.equal(actor.parent.id, 'parent-1');
  assert.equal(calls.touchLastUsed, 1);
});

test('authenticateParentKey rejects a deleted manager without returning an actor', async () => {
  const { ports, calls } = portsFor({
    account: managerAccount({ status: 'deleted' }),
  });
  await assert.rejects(() => authenticateParentKey(ports, issued.secret), isInvalidParent);
  assert.equal(calls.touchLastUsed, 0);
});

test('authenticateParentKey rejects a manager with deletedAt set', async () => {
  const { ports, calls } = portsFor({
    account: managerAccount({ deletedAt: NOW }),
  });
  await assert.rejects(() => authenticateParentKey(ports, issued.secret), isInvalidParent);
  assert.equal(calls.touchLastUsed, 0);
});

test('authenticateParentKey rejects a missing manager account', async () => {
  const { ports, calls } = portsFor({ account: null });
  await assert.rejects(() => authenticateParentKey(ports, issued.secret), isInvalidParent);
  assert.equal(calls.touchLastUsed, 0);
});
