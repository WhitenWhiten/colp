import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertGrantStillValidForPlan, assertReportPublishAuthorized } from '../../../src/modules/auth/index.js';
import { ancestorEpochDigest } from '../../../src/modules/auth/index.js';
import type { AccountCredentialRecord } from '../../../src/modules/auth/index.js';
import type {
  AccountCredentialClock,
  CredentialGrantCommandPorts,
  CredentialGrantMachineBindingPort,
  CredentialGrantRecord,
  CredentialPlanAuthorizationRecord,
  StoredCredentialPlan,
  StoredPlanBinding,
} from '../../../src/modules/auth/index.js';

const now = new Date('2026-09-15T00:00:00.000Z');
const DIGEST = 'sha-256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function authorization(overrides: Partial<CredentialPlanAuthorizationRecord> = {}): CredentialPlanAuthorizationRecord {
  return {
    planKind: 'collection',
    planId: 'plan-1',
    grantId: 'grant-1',
    grantRevision: 1n,
    credentialId: 'child-1',
    planDigest: DIGEST,
    authorizedAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  };
}

function grant(overrides: Partial<CredentialGrantRecord> = {}): CredentialGrantRecord {
  return {
    id: 'grant-1',
    credentialId: 'child-1',
    ownerAccountId: 'account-1',
    resource: { kind: 'collection', id: 'collection-1' },
    actions: Object.freeze(['collection.publish']),
    state: 'active',
    revision: 1n,
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    revokedAt: null,
    revokeReason: null,
    ...overrides,
  };
}

function credential(id: string, parentId: string | null, overrides: Partial<AccountCredentialRecord> = {}): AccountCredentialRecord {
  return {
    id,
    kind: parentId === null ? 'parent' : 'child',
    parentId,
    accountId: 'account-1',
    subjectId: 'subject-1',
    managerAccountId: 'manager-1',
    label: id,
    prefix: id.slice(0, 8),
    secretHash: 'x',
    state: 'active',
    revision: 1n,
    epoch: 1n,
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    lastUsedAt: null,
    revokedAt: null,
    revokeReason: null,
    mcpClientId: `mcp-${id}`,
    ...overrides,
  };
}

function machinePort(): CredentialGrantMachineBindingPort {
  return {
    issuer: () => 'https://app.example.test/api/v1/auth',
    securityEpoch: async () => 'server-epoch-1',
    expectedBindingId: (input) => `binding-${input.credentialId}-${input.resourceAudience}-${input.accountEpoch}-${input.credentialEpoch}-${input.ancestorEpochDigest.slice(0, 8)}-${input.serverSecurityEpoch}`,
  };
}

function planFor(machine: CredentialGrantMachineBindingPort, snapshotArgs: {
  ancestorEpochDigest: string; accountEpoch: string; credentialEpoch: string;
}): { plan: StoredCredentialPlan; binding: StoredPlanBinding } {
  const binding: StoredPlanBinding = {
    kind: 'authenticated',
    principalId: 'account-1',
    clientId: 'mcp-child-1',
    credentialBindingId: machine.expectedBindingId({
      clientId: 'mcp-child-1',
      credentialId: 'child-1',
      resourceAudience: 'https://app.example.test/collections/-/mcp',
      accountEpoch: snapshotArgs.accountEpoch,
      credentialEpoch: snapshotArgs.credentialEpoch,
      ancestorEpochDigest: snapshotArgs.ancestorEpochDigest,
      serverSecurityEpoch: 'server-epoch-1',
    }),
    resourceAudience: 'https://app.example.test/collections/-/mcp',
    securityEpoch: 'server-epoch-1',
  };
  return {
    binding,
    plan: {
      planKind: 'collection',
      planId: 'plan-1',
      operationsDigest: DIGEST,
      requiredScopes: Object.freeze(['access:write']),
      requiredActions: ['collection.publish'],
      status: 'pending',
      approvalStatus: 'approved',
      expiresAt: '2026-12-01T00:00:00.000Z',
      binding,
      resourceIds: Object.freeze(['collection-1']),
    },
  };
}

function buildPorts(input: {
  authorization?: CredentialPlanAuthorizationRecord | null;
  grantValue?: CredentialGrantRecord | null;
  plan?: StoredCredentialPlan | null;
  now?: Date;
}): {
  ports: CredentialGrantCommandPorts;
  calls: { lockAuthorization: number; lockGrant: number; findAuthorization: number; findGrant: number };
} {
  const records = new Map<string, AccountCredentialRecord>([
    ['child-1', credential('child-1', 'parent-1')],
    ['parent-1', credential('parent-1', null)],
  ]);
  const machine = machinePort();
  const snapshot = {
    ancestorEpochDigest: ancestorEpochDigest([records.get('parent-1')!]),
    accountEpoch: '1',
    credentialEpoch: '1',
  };
  const { plan } = planFor(machine, snapshot);
  const calls = {
    lockAuthorization: 0, lockGrant: 0, findAuthorization: 0, findGrant: 0,
    findPublishLock: undefined as boolean | undefined,
  };
  const clocks: AccountCredentialClock = { now: async () => input.now ?? now };
  const ports: CredentialGrantCommandPorts = {
    receipts: {} as CredentialGrantCommandPorts['receipts'],
    credentials: {
      findById: async (id) => records.get(id) ?? null,
    } as CredentialGrantCommandPorts['credentials'],
    accounts: {
      findAccountById: async () => ({
        id: 'account-1',
        subjectId: 'subject-1',
        status: 'active',
        securityEpoch: 1n,
        deletedAt: null,
      }),
    } as CredentialGrantCommandPorts['accounts'],
    grants: {
      findPlanAuthorization: async () => {
        calls.findAuthorization += 1;
        return input.authorization === undefined ? authorization() : input.authorization;
      },
      lockPlanAuthorization: async () => {
        calls.lockAuthorization += 1;
        return input.authorization === undefined ? authorization() : input.authorization;
      },
      findReportPublishAuthorization: async ({ lock }) => {
        calls.findPublishLock = lock === true;
        return input.authorization === undefined ? authorization() : input.authorization;
      },
      findById: async () => {
        calls.findGrant += 1;
        return input.grantValue ?? grant();
      },
      lockById: async () => {
        calls.lockGrant += 1;
        return input.grantValue ?? grant();
      },
    } as CredentialGrantCommandPorts['grants'],
    resources: {} as CredentialGrantCommandPorts['resources'],
    plans: {
      getPlan: async () => input.plan ?? plan,
    } as CredentialGrantCommandPorts['plans'],
    machine,
    clock: clocks,
    ids: {} as CredentialGrantCommandPorts['ids'],
  };
  return { ports, calls };
}

test('lock re-check takes row locks on the authorization and grant', async () => {
  const { ports, calls } = buildPorts({});
  await assertGrantStillValidForPlan(ports, { planKind: 'collection', planId: 'plan-1' }, { lock: true });
  assert.equal(calls.lockAuthorization, 1);
  assert.equal(calls.lockGrant, 1);
  assert.equal(calls.findAuthorization, 0);
  assert.equal(calls.findGrant, 0);
});

test('non-locking re-check reads without row locks', async () => {
  const { ports, calls } = buildPorts({});
  await assertGrantStillValidForPlan(ports, { planKind: 'collection', planId: 'plan-1' });
  assert.equal(calls.lockAuthorization, 0);
  assert.equal(calls.lockGrant, 0);
  assert.equal(calls.findAuthorization, 1);
  assert.equal(calls.findGrant, 1);
});

test('lock re-check rejects a grant revoked before the commit', async () => {
  const { ports, calls } = buildPorts({
    grantValue: grant({ state: 'revoked', revision: 2n, revokedAt: now, revokeReason: 'stop' }),
  });
  await assert.rejects(
    assertGrantStillValidForPlan(ports, { planKind: 'collection', planId: 'plan-1' }, { lock: true }),
    (error: unknown) => error instanceof Error && error.message.includes('no longer valid'),
  );
  assert.equal(calls.lockAuthorization, 1);
  assert.equal(calls.lockGrant, 1);
});

test('lock re-check treats a missing authorization as pass-through (no grant to lock)', async () => {
  const { ports, calls } = buildPorts({ authorization: null, grantValue: null, plan: null });
  await assertGrantStillValidForPlan(ports, { planKind: 'collection', planId: 'plan-1' }, { lock: true });
  assert.equal(calls.lockAuthorization, 1);
  assert.equal(calls.lockGrant, 0);
});

test('HTTP report publish re-check requests lock: true', async () => {
  const machine = machinePort();
  const snapshot = {
    ancestorEpochDigest: ancestorEpochDigest([credential('parent-1', null)]),
    accountEpoch: '1',
    credentialEpoch: '1',
  };
  const { binding } = planFor(machine, snapshot);
  const { ports, calls } = buildPorts({
    authorization: authorization({ planKind: 'report' }),
    grantValue: grant({
      resource: { kind: 'report', id: 'series-1' },
      actions: Object.freeze(['report.issue.publish']),
    }),
    plan: {
      planKind: 'report',
      planId: 'plan-1',
      operationsDigest: DIGEST,
      requiredScopes: Object.freeze(['reports:write', 'reports:publish']),
      requiredActions: ['report.issue.publish'],
      status: 'pending',
      approvalStatus: 'approved',
      expiresAt: '2026-12-01T00:00:00.000Z',
      binding,
      resourceIds: Object.freeze(['series-1']),
    },
  });
  await assertReportPublishAuthorized(ports, {
    seriesId: 'series-1',
    editionId: 'edition-1',
    accountId: 'account-1',
    credentialId: 'child-1',
    scopes: ['reports:publish'],
  }, { lock: true });
  assert.equal(calls.findPublishLock, true);
  assert.equal(calls.lockAuthorization, 1);
  assert.ok(calls.lockGrant >= 1);
  assert.equal(calls.findAuthorization, 0);
  assert.equal(calls.findGrant, 0);
});