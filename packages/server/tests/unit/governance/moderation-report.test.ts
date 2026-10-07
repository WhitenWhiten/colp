import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import {
  getModerationCase,
  getModerationEvidence,
  getMyModerationReport,
  listModerationCases,
} from '../../../src/modules/governance/application/moderation-queries.js';
import { submitModerationReport } from '../../../src/modules/governance/application/moderation-report.js';
import type {
  ModerationCaseRecord,
  ModerationCommandPorts,
  ModerationQueryPorts,
  ModerationRolePorts,
  ModerationStore,
} from '../../../src/modules/governance/application/moderation-ports.js';
import {
  GovernanceModerationError,
  type Evidence,
  type GovernanceTarget,
  type ModerationRole,
  type ReportInput,
} from '../../../src/modules/governance/domain/moderation.js';

const HMAC = Buffer.alloc(32, 7).toString('base64url');
const ACTOR = { accountId: 'acc_reporter', subjectId: 'sub_reporter', principalId: 'acc_reporter' };
const TARGET: GovernanceTarget = { kind: 'collection', id: 'col_public' };

function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    target: TARGET,
    category: 'spam',
    description: 'unsolicited advertising',
    ...overrides,
  };
}

function memoryReceipts(): ProductCommandReceiptPort {
  const claimed = new Map<string, { fingerprint: string; result?: ProductCommandResult }>();
  const keyOf = (binding: ProductCommandBinding) =>
    `${binding.principalId}|${binding.commandScope}|${binding.commandId}`;
  return {
    async claim(binding, fingerprint): Promise<ProductCommandClaim> {
      const key = keyOf(binding);
      const current = claimed.get(key);
      if (!current) {
        claimed.set(key, { fingerprint });
        return { kind: 'claimed' };
      }
      if (current.result && current.fingerprint === fingerprint) {
        return { kind: 'replay', result: current.result };
      }
      if (current.result) return { kind: 'reused' };
      return { kind: 'in_progress', retryAfterSeconds: 1 };
    },
    async complete(binding, fingerprint, result) {
      claimed.set(keyOf(binding), { fingerprint, result });
    },
    async purgeExpired() { return 0; },
    async deletePrincipalReceipts() { return 0; },
  };
}

function memoryStore(): ModerationStore & { cases: ModerationCaseRecord[]; evidence: Evidence[] } {
  const cases: ModerationCaseRecord[] = [];
  const evidence: Evidence[] = [];
  const emptyControl = Object.freeze({ hidePublic: false, delisted: false });
  const emptyAccount = Object.freeze({ restrictInteraction: false, restrictPublication: false });
  return {
    cases,
    evidence,
    async insertCase(record) {
      if (cases.some((row) => (
        row.reporterAccountId === record.reporterAccountId
        && row.targetFingerprint === record.targetFingerprint
        && row.category === record.category
        && (row.status === 'submitted' || row.status === 'in_review')
      ))) return 'duplicate_open';
      cases.push(record);
      return 'inserted';
    },
    async findOpenCase(reporterAccountId, targetFingerprint, category) {
      return cases.find((row) => (
        row.reporterAccountId === reporterAccountId
        && row.targetFingerprint === targetFingerprint
        && row.category === category
        && (row.status === 'submitted' || row.status === 'in_review')
      )) ?? null;
    },
    async getCase(caseId) {
      return cases.find((row) => row.id === caseId) ?? null;
    },
    async listReporterCases(reporterAccountId, read) {
      return cases.filter((row) => (
        row.reporterAccountId === reporterAccountId
        && (read.status === undefined || row.status === read.status)
      )).slice(0, read.limit);
    },
    async listOfficialCases(read) {
      return cases.filter((row) => (
        (read.status === undefined || row.status === read.status)
        && (read.assignee === undefined || row.assignedToAccountId === read.assignee)
      )).slice(0, read.limit);
    },
    async insertEvidence(row) { evidence.push(row); },
    async getEvidence(caseId, evidenceId) {
      return evidence.find((row) => row.caseId === caseId && row.id === evidenceId) ?? null;
    },
    async updateCase() { return false; },
    async insertAction() {},
    async getAction() { return null; },
    async updateAction() { return false; },
    async listActionsForTarget() { return []; },
    async listActionsAffectingOwner() { return []; },
    async actionOwnerAccountId() { return null; },
    async isAffectedOwner() { return false; },
    async insertAppeal() { return 'inserted'; },
    async findOpenAppeal() { return null; },
    async getAppeal() { return null; },
    async updateAppeal() { return false; },
    async listAppellantAppeals() { return []; },
    async listOfficialAppeals() { return []; },
    async listExpiredEvidence() { return []; },
    async recycleExpiredEvidence() { return 0; },
    async collectionControl() { return emptyControl; },
    async collectionControls() { return new Map(); },
    async collectionPublicationSlug() { return null; },
    async bookmarkFaviconObjectId() { return null; },
    async digestSeriesSlug() { return null; },
    async accountControl() { return emptyAccount; },
    async accountControls() { return new Map(); },
    async accountPublicLocator() { return { handle: null, avatarObjectId: null }; },
  };
}

function commandPorts(
  store: ModerationStore,
  options: { readable?: boolean; conceal?: boolean } = {},
): ModerationCommandPorts {
  let caseSeq = 0;
  let evidenceSeq = 0;
  return {
    receipts: memoryReceipts(),
    store,
    targets: {
      async resolve(_actor, target) {
        if (options.conceal) {
          throw new GovernanceModerationError('resource_not_found', 'target was not found', 'conceal');
        }
        if (options.readable === false) {
          throw new GovernanceModerationError('insufficient_permission', 'target is not readable', 'deny');
        }
        return {
          target,
          capturedAt: '2026-09-15T00:00:00.000Z',
          sourceRevision: 'rev_1',
          title: 'Public Notes',
          text: 'a public collection',
          sourceUrl: null,
        };
      },
    },
    clock: { now: async () => new Date('2026-09-15T00:00:00.000Z') },
    roles: {
      async getRoles() { return new Set(); },
      async grant() { return false; },
      async revoke() { return false; },
      async accountExists() { return true; },
    },
    audit: { async append() { return 'audit_1'; } },
    outbox: { async appendCollectionControl() {}, async appendBookmarkControl() {}, async appendDigestControl() {}, async appendAccountControl() {} },
    ids: {
      nextCaseId: () => `case_${caseSeq += 1}`,
      nextEvidenceId: () => `ev_${evidenceSeq += 1}`,
      nextActionId: () => 'act_1',
      nextAppealId: () => 'apl_1',
      nextOutboxId: () => 'out_1',
      nextEventId: () => 'evt_1',
    },
  };
}

function fingerprint(commandId: string, body: ReportInput): string {
  return canonicalCommandFingerprint({
    method: 'POST',
    route: '/api/v1/moderation/reports',
    mediaType: 'application/json',
    body,
    query: {},
  });
}

test('submit creates a case and evidence without punitive actions', async () => {
  const store = memoryStore();
  const ports = commandPorts(store);
  const body = report();
  const outcome = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('11111111-1111-4111-8111-111111111111', body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  assert.equal(outcome.kind, 'created');
  if (outcome.kind !== 'created') return;
  assert.equal(outcome.status, 201);
  assert.equal(outcome.case.status, 'submitted');
  assert.equal(store.cases.length, 1);
  assert.equal(store.evidence.length, 1);
  assert.equal(Object.hasOwn(outcome.case, 'description'), false);
  assert.equal(Object.hasOwn(outcome.case, 'evidenceIds'), false);
});

test('private or unreadable targets do not create a case', async () => {
  const store = memoryStore();
  const body = report();
  await assert.rejects(
    () => submitModerationReport(commandPorts(store, { conceal: true }), {
      actor: ACTOR,
      commandId: '11111111-1111-4111-8111-111111111111',
      fingerprint: fingerprint('11111111-1111-4111-8111-111111111111', body),
      commandScope: 'POST /api/v1/moderation/reports',
      report: body,
    }),
    (error: unknown) => error instanceof GovernanceModerationError && error.code === 'resource_not_found',
  );
  assert.equal(store.cases.length, 0);
});

test('a different command id for the same open reporter/target/category returns the existing case', async () => {
  const store = memoryStore();
  const ports = commandPorts(store);
  const body = report();
  const first = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('11111111-1111-4111-8111-111111111111', body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  const second = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId: '22222222-2222-4222-8222-222222222222',
    fingerprint: fingerprint('22222222-2222-4222-8222-222222222222', body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  assert.equal(first.kind, 'created');
  assert.equal(second.kind, 'deduped');
  if (first.kind !== 'created' || second.kind !== 'deduped') return;
  assert.equal(second.status, 200);
  assert.equal(second.case.id, first.case.id);
  assert.equal(store.cases.length, 1);
});

test('identical command id replays the original receipt instead of deduping', async () => {
  const store = memoryStore();
  const ports = commandPorts(store);
  const body = report();
  const commandId = '11111111-1111-4111-8111-111111111111';
  const first = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId,
    fingerprint: fingerprint(commandId, body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  const replay = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId,
    fingerprint: fingerprint(commandId, body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  assert.equal(first.kind, 'created');
  assert.equal(replay.kind, 'replay');
  if (replay.kind !== 'replay') return;
  assert.equal(replay.status, 201);
});

test('reporter reads cannot see official fields or evidence', async () => {
  const store = memoryStore();
  const ports = commandPorts(store);
  const body = report();
  const created = await submitModerationReport(ports, {
    actor: ACTOR,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('11111111-1111-4111-8111-111111111111', body),
    commandScope: 'POST /api/v1/moderation/reports',
    report: body,
  });
  assert.equal(created.kind, 'created');
  if (created.kind !== 'created') return;
  const query = queryPorts(store, new Map());
  const mine = await getMyModerationReport(query, { accountId: ACTOR.accountId, caseId: created.case.id });
  assert.equal(Object.hasOwn(mine.view, 'description'), false);
  assert.equal(Object.hasOwn(mine.view, 'reporterAccountId'), false);
  await assert.rejects(
    () => getModerationEvidence(query, {
      accountId: ACTOR.accountId,
      caseId: created.case.id,
      evidenceId: store.evidence[0]!.id,
    }),
    (error: unknown) => error instanceof GovernanceModerationError
      && error.code === 'insufficient_permission',
  );
});

test('non-reviewers cannot list official cases', async () => {
  const store = memoryStore();
  const query = queryPorts(store, new Map());
  await assert.rejects(
    () => listModerationCases(query, HMAC, { accountId: ACTOR.accountId, query: {} }),
    (error: unknown) => error instanceof GovernanceModerationError
      && error.code === 'insufficient_permission',
  );
});

test('reviewer grant is audited and official reads include reporter fields', async () => {
  const store = memoryStore();
  const created = await submitModerationReport(commandPorts(store), {
    actor: ACTOR,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('11111111-1111-4111-8111-111111111111', report()),
    commandScope: 'POST /api/v1/moderation/reports',
    report: report(),
  });
  assert.equal(created.kind, 'created');
  if (created.kind !== 'created') return;
  const roles = new Map<string, Set<ModerationRole>>();
  const audits: string[] = [];
  const rolePorts: ModerationRolePorts = {
    roles: {
      async getRoles(accountId) { return roles.get(accountId) ?? new Set(); },
      async grant(accountId, role) {
        const current = roles.get(accountId) ?? new Set<ModerationRole>();
        if (current.has(role)) return false;
        current.add(role);
        roles.set(accountId, current);
        return true;
      },
      async revoke(accountId, role) {
        const current = roles.get(accountId);
        if (!current?.has(role)) return false;
        current.delete(role);
        return true;
      },
      async accountExists() { return true; },
    },
    audit: {
      async append() {
        const id = `audit_${audits.length + 1}`;
        audits.push(id);
        return id;
      },
    },
  };
  const granted = await grantModerationRole(rolePorts, {
    accountId: 'acc_reviewer',
    role: 'reviewer',
    reason: 'on-call',
  });
  assert.equal(granted.changed, true);
  assert.equal(granted.auditId, 'audit_1');
  const repeat = await grantModerationRole(rolePorts, {
    accountId: 'acc_reviewer',
    role: 'reviewer',
    reason: 'on-call',
  });
  assert.equal(repeat.changed, false);
  assert.equal(audits.length, 1);
  const official = await getModerationCase(queryPorts(store, roles), {
    accountId: 'acc_reviewer',
    caseId: created.case.id,
  });
  assert.equal(official.view.reporterAccountId, ACTOR.accountId);
  assert.equal(official.view.description, 'unsolicited advertising');
  assert.deepEqual(official.view.evidenceIds, [store.evidence[0]!.id]);
  assert.deepEqual(official.view.actionIds, []);
});

function queryPorts(
  store: ModerationStore,
  roles: Map<string, Set<ModerationRole>>,
): ModerationQueryPorts {
  return {
    store,
    roles: {
      async getRoles(accountId) { return roles.get(accountId) ?? new Set(); },
      async grant() { return false; },
      async revoke() { return false; },
      async accountExists() { return true; },
    },
    clock: { now: async () => new Date('2026-09-15T00:00:00.000Z') },
  };
}
