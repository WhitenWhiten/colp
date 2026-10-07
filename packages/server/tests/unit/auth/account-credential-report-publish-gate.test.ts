import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AccountCredentialCommandError,
  ancestorEpochDigest,
  assertReportPublishAuthorized,
} from '../../../src/modules/auth/index.js';
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
    planKind: 'report',
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
    resource: { kind: 'report', id: 'series-1' },
    actions: Object.freeze(['report.issue.publish']),
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
}, requiredScopes: readonly string[] = ['reports:write', 'reports:publish']): {
  plan: StoredCredentialPlan; binding: StoredPlanBinding;
} {
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
      planKind: 'report',
      planId: 'plan-1',
      operationsDigest: DIGEST,
      requiredScopes: Object.freeze([...requiredScopes]),
      requiredActions: ['report.issue.publish'],
      status: 'pending',
      approvalStatus: 'approved',
      expiresAt: '2026-12-01T00:00:00.000Z',
      binding,
      resourceIds: Object.freeze(['series-1']),
    },
  };
}

function buildPorts(input: {
  authorization?: CredentialPlanAuthorizationRecord | null;
  grantValue?: CredentialGrantRecord | null;
  requiredScopes?: readonly string[];
}): {
  ports: CredentialGrantCommandPorts;
  calls: {
    findPublishLock: boolean | undefined;
    lockGrant: number;
    findGrant: number;
    lockAuthorization: number;
    findAuthorization: number;
  };
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
  const { plan } = planFor(machine, snapshot, input.requiredScopes);
  const clocks: AccountCredentialClock = { now: async () => now };
  const calls = {
    findPublishLock: undefined as boolean | undefined,
    lockGrant: 0,
    findGrant: 0,
    lockAuthorization: 0,
    findAuthorization: 0,
  };
  const resolvedAuthorization = input.authorization === undefined ? authorization() : input.authorization;
  const resolvedGrant = input.grantValue === undefined ? grant() : input.grantValue;
  return {
    calls,
    ports: {
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
        findReportPublishAuthorization: async ({ lock }) => {
          calls.findPublishLock = lock === true;
          return resolvedAuthorization;
        },
        findPlanAuthorization: async () => {
          calls.findAuthorization += 1;
          return resolvedAuthorization;
        },
        lockPlanAuthorization: async () => {
          calls.lockAuthorization += 1;
          return resolvedAuthorization;
        },
        findById: async () => {
          calls.findGrant += 1;
          return resolvedGrant;
        },
        lockById: async () => {
          calls.lockGrant += 1;
          return resolvedGrant;
        },
        consumeReportPublishAuthorization: async () => undefined,
      } as CredentialGrantCommandPorts['grants'],
      resources: {} as CredentialGrantCommandPorts['resources'],
      plans: {
        getPlan: async () => plan,
      } as CredentialGrantCommandPorts['plans'],
      machine,
      clock: clocks,
      ids: {} as CredentialGrantCommandPorts['ids'],
    },
  };
}

const publishInput = {
  seriesId: 'series-1',
  editionId: 'edition-1',
  accountId: 'account-1',
  credentialId: 'child-1',
  scopes: ['reports:publish'],
};

test('HTTP publish gate returns the authorizing plan id', async () => {
  const result = await assertReportPublishAuthorized(buildPorts({}).ports, publishInput);
  assert.deepEqual(result, { planId: 'plan-1' });
});

test('HTTP publish gate requires reports:publish even when a plan is authorized', async () => {
  await assert.rejects(
    () => assertReportPublishAuthorized(buildPorts({}).ports, { ...publishInput, scopes: ['reports:write'] }),
    (error: unknown) => error instanceof AccountCredentialCommandError
      && error.code === 'insufficient_permission'
      && error.message.includes('reports:publish'),
  );
});

test('HTTP publish gate rejects a grant that does not include report.issue.publish', async () => {
  await assert.rejects(
    () => assertReportPublishAuthorized(buildPorts({
      grantValue: grant({ actions: Object.freeze(['report.metadata.write']) }),
      requiredScopes: ['reports:write'],
    }).ports, publishInput),
    (error: unknown) => error instanceof AccountCredentialCommandError
      && error.code === 'insufficient_permission'
      && error.message.includes('report.issue.publish'),
  );
});

test('HTTP publish gate rejects when no edition.publish authorization matches', async () => {
  await assert.rejects(
    () => assertReportPublishAuthorized(buildPorts({ authorization: null }).ports, publishInput),
    (error: unknown) => error instanceof AccountCredentialCommandError
      && error.code === 'insufficient_permission'
      && error.message.includes('approved plan authorization'),
  );
});

test('HTTP publish gate lock re-check takes row locks on authorization and grant', async () => {
  const { ports, calls } = buildPorts({});
  await assertReportPublishAuthorized(ports, publishInput, { lock: true });
  assert.equal(calls.findPublishLock, true);
  assert.equal(calls.lockGrant, 2);
  assert.equal(calls.lockAuthorization, 1);
  assert.equal(calls.findGrant, 0);
  assert.equal(calls.findAuthorization, 0);
});

test('HTTP publish gate without lock reads without row locks', async () => {
  const { ports, calls } = buildPorts({});
  await assertReportPublishAuthorized(ports, publishInput);
  assert.equal(calls.findPublishLock, false);
  assert.equal(calls.lockGrant, 0);
  assert.equal(calls.lockAuthorization, 0);
  assert.equal(calls.findGrant, 2);
  assert.equal(calls.findAuthorization, 1);
});
