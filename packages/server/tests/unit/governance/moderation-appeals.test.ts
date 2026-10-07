import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import {
  createModerationAppeal,
  decideModerationAppeal,
} from '../../../src/modules/governance/application/moderation-appeal-commands.js';
import { getModerationAppeal } from '../../../src/modules/governance/application/moderation-appeal-queries.js';
import type {
  ModerationActionRecord,
  ModerationAppealRecord,
  ModerationCommandPorts,
  ModerationQueryPorts,
  ModerationStore,
} from '../../../src/modules/governance/application/moderation-ports.js';
import { GovernanceModerationError } from '../../../src/modules/governance/domain/moderation.js';
import {
  parseAppealDecision,
  parseAppealInput,
} from '../../../src/modules/governance/domain/moderation-appeals.js';
import { createGovernanceCollectionControlRoutes } from '../../../src/infrastructure/outbox/governance-collection-control.js';
import { GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';

const OWNER = { accountId: 'acc_owner', principalId: 'acc_owner' };
const MODERATOR = { accountId: 'acc_mod', principalId: 'acc_mod' };
const STRANGER = { accountId: 'acc_stranger', principalId: 'acc_stranger' };
const TARGET = { kind: 'collection' as const, id: 'col_1' };

function fingerprint(method: string, route: string, body: unknown, ifMatch?: string): string {
  return canonicalCommandFingerprint({
    method,
    route,
    mediaType: 'application/json',
    body,
    query: {},
    ...(ifMatch ? { conditions: { ifMatch } } : {}),
  });
}

function memoryReceipts(): ProductCommandReceiptPort {
  const claimed = new Map<string, { fingerprint: string; result?: ProductCommandResult }>();
  const keyOf = (binding: ProductCommandBinding) =>
    `${binding.principalId}|${binding.commandScope}|${binding.commandId}`;
  return {
    async claim(binding, next): Promise<ProductCommandClaim> {
      const key = keyOf(binding);
      const current = claimed.get(key);
      if (!current) {
        claimed.set(key, { fingerprint: next });
        return { kind: 'claimed' };
      }
      if (current.result && current.fingerprint === next) {
        return { kind: 'replay', result: current.result };
      }
      if (current.result) return { kind: 'reused' };
      return { kind: 'in_progress', retryAfterSeconds: 1 };
    },
    async complete(binding, next, result) {
      claimed.set(keyOf(binding), { fingerprint: next, result });
    },
    async purgeExpired() { return 0; },
    async deletePrincipalReceipts() { return 0; },
  };
}

function actionRecord(id: string, action: 'hide_public' | 'delist'): ModerationActionRecord {
  return {
    id,
    caseId: 'case_1',
    target: TARGET,
    targetFingerprint: 'collection:col_1',
    action,
    reason: `${action} reason`,
    actorAccountId: MODERATOR.accountId,
    state: 'active',
    revision: '1',
    createdAt: '2026-09-15T00:00:00.000Z',
    revokedAt: null,
    revokeReason: null,
    revokedByAccountId: null,
    ownerAccountId: OWNER.accountId,
  };
}

function memoryStore(seed: readonly ModerationActionRecord[]): ModerationStore & {
  actions: ModerationActionRecord[];
  appeals: ModerationAppealRecord[];
} {
  const actions = [...seed];
  const appeals: ModerationAppealRecord[] = [];
  const emptyControl = Object.freeze({ hidePublic: false, delisted: false });
  const emptyAccount = Object.freeze({ restrictInteraction: false, restrictPublication: false });
  return {
    actions,
    appeals,
    async insertCase() { return 'inserted'; },
    async findOpenCase() { return null; },
    async getCase() { return null; },
    async updateCase() { return false; },
    async listReporterCases() { return []; },
    async listOfficialCases() { return []; },
    async insertEvidence() {},
    async getEvidence() { return null; },
    async insertAction(record) { actions.push(record); },
    async getAction(actionId) { return actions.find((row) => row.id === actionId) ?? null; },
    async updateAction(record, expectedRevision) {
      const index = actions.findIndex((row) => row.id === record.id && row.revision === expectedRevision);
      if (index < 0) return false;
      actions[index] = record;
      return true;
    },
    async listActionsForTarget() { return actions; },
    async listActionsAffectingOwner() { return actions; },
    async actionOwnerAccountId() { return OWNER.accountId; },
    async isAffectedOwner(accountId, actionId) {
      return accountId === OWNER.accountId && actions.some((row) => row.id === actionId);
    },
    async insertAppeal(record) {
      if (appeals.some((row) => row.actionId === record.actionId && row.status === 'submitted')) {
        return 'duplicate_open';
      }
      appeals.push(record);
      return 'inserted';
    },
    async findOpenAppeal(actionId) {
      return appeals.find((row) => row.actionId === actionId && row.status === 'submitted') ?? null;
    },
    async getAppeal(appealId) { return appeals.find((row) => row.id === appealId) ?? null; },
    async updateAppeal(record, expectedRevision) {
      const index = appeals.findIndex((row) => row.id === record.id && row.revision === expectedRevision);
      if (index < 0) return false;
      appeals[index] = record;
      return true;
    },
    async listAppellantAppeals() { return appeals; },
    async listOfficialAppeals() { return appeals; },
    async listExpiredEvidence() { return []; },
    async recycleExpiredEvidence() { return 0; },
    async collectionControl() { return emptyControl; },
    async collectionControls() { return new Map(); },
    async collectionPublicationSlug() { return 'notes'; },
    async bookmarkFaviconObjectId() { return null; },
    async digestSeriesSlug() { return null; },
    async accountControl() { return emptyAccount; },
    async accountControls() { return new Map(); },
    async accountPublicLocator() { return { handle: null, avatarObjectId: null }; },
  };
}

function queryPorts(
  store: ModerationStore,
  roles: ReadonlySet<'reviewer' | 'moderator'>,
): ModerationQueryPorts {
  return {
    store,
    clock: { now: async () => new Date('2026-09-16T00:00:00.000Z') },
    roles: {
      async getRoles() { return roles; },
      async grant() { return false; },
      async revoke() { return false; },
      async accountExists() { return true; },
    },
  };
}

function commandPorts(store: ModerationStore, roles: ReadonlySet<'reviewer' | 'moderator'>): ModerationCommandPorts {
  let appealSeq = 0;
  return {
    receipts: memoryReceipts(),
    store,
    targets: {
      async resolve() {
        throw new Error('unused');
      },
    },
    clock: { now: async () => new Date('2026-09-16T00:00:00.000Z') },
    roles: {
      async getRoles() { return roles; },
      async grant() { return false; },
      async revoke() { return false; },
      async accountExists() { return true; },
    },
    audit: { async append() { return 'audit_1'; } },
    outbox: {
      async appendCollectionControl() {},
      async appendBookmarkControl() {},
      async appendDigestControl() {},
      async appendAccountControl() {},
    },
    ids: {
      nextCaseId: () => 'case_x',
      nextEvidenceId: () => 'ev_x',
      nextActionId: () => 'act_x',
      nextAppealId: () => `apl_${appealSeq += 1}`,
      nextOutboxId: () => 'out_1',
      nextEventId: () => 'evt_1',
    },
  };
}

test('AppealInput and decision body are closed JSON objects', () => {
  assert.deepEqual(parseAppealInput({ actionId: 'act_1', description: 'false positive' }), {
    actionId: 'act_1',
    description: 'false positive',
  });
  assert.throws(
    () => parseAppealInput({ actionId: 'act_1', description: 'ok', extra: true }),
    (error: unknown) => error instanceof GovernanceModerationError && error.code === 'invalid_request',
  );
  assert.deepEqual(parseAppealDecision({ decision: 'uphold', resolution: 'restore listing' }), {
    decision: 'uphold',
    resolution: 'restore listing',
  });
  assert.throws(() => parseAppealDecision({ decision: 'uphold' }));
  assert.throws(() => parseAppealDecision({ decision: 'maybe', resolution: 'no' }));
});

test('non-owner cannot create an appeal', async () => {
  const store = memoryStore([actionRecord('act_hide', 'hide_public')]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'please restore' });
  await assert.rejects(
    () => createModerationAppeal(commandPorts(store, new Set()), {
      actor: STRANGER,
      commandId: '11111111-1111-4111-8111-111111111111',
      fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
      commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
      body,
    }),
    (error: unknown) => error instanceof GovernanceModerationError
      && error.code === 'resource_not_found'
      && error.outcome === 'conceal',
  );
  assert.equal(store.appeals.length, 0);
});

test('duplicate open appeal for the same action is revision_conflict', async () => {
  const store = memoryStore([actionRecord('act_hide', 'hide_public')]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'please restore' });
  const first = await createModerationAppeal(commandPorts(store, new Set()), {
    actor: OWNER,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
    commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
    body,
  });
  assert.equal(first.kind, 'written');
  await assert.rejects(
    () => createModerationAppeal(commandPorts(store, new Set()), {
      actor: OWNER,
      commandId: '22222222-2222-4222-8222-222222222222',
      fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
      commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
      body,
    }),
    (error: unknown) => error instanceof GovernanceModerationError && error.code === 'revision_conflict',
  );
});

test('uphold revokes only the appealed action and leaves a sibling active', async () => {
  const hide = actionRecord('act_hide', 'hide_public');
  const delist = actionRecord('act_delist', 'delist');
  const store = memoryStore([hide, delist]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'hide was a mistake' });
  const created = await createModerationAppeal(commandPorts(store, new Set()), {
    actor: OWNER,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
    commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
    body,
  });
  assert.equal(created.kind, 'written');
  if (created.kind !== 'written') return;
  const decision = parseAppealDecision({ decision: 'uphold', resolution: 'false positive hide' });
  const decided = await decideModerationAppeal(commandPorts(store, new Set(['moderator'])), {
    actor: MODERATOR,
    commandId: '33333333-3333-4333-8333-333333333333',
    fingerprint: fingerprint('POST', `/api/v1/moderation/appeals/${created.view.id}/decision`, decision, '"1"'),
    commandScope: `http:v1:POST:/api/v1/moderation/appeals/${created.view.id}/decision`,
    appealId: created.view.id,
    ifMatch: '"1"',
    body: decision,
  });
  assert.equal(decided.kind, 'written');
  if (decided.kind !== 'written') return;
  assert.equal(decided.view.status, 'upheld');
  assert.equal(store.actions.find((row) => row.id === 'act_hide')?.state, 'revoked');
  assert.equal(store.actions.find((row) => row.id === 'act_delist')?.state, 'active');
});

test('appellant and official can get an appeal; stranger cannot', async () => {
  const store = memoryStore([actionRecord('act_hide', 'hide_public')]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'please restore' });
  const created = await createModerationAppeal(commandPorts(store, new Set()), {
    actor: OWNER,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
    commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
    body,
  });
  assert.equal(created.kind, 'written');
  if (created.kind !== 'written') return;
  const ownerRead = await getModerationAppeal(queryPorts(store, new Set()), {
    accountId: OWNER.accountId,
    appealId: created.view.id,
  });
  assert.equal(ownerRead.view.id, created.view.id);
  const officialRead = await getModerationAppeal(queryPorts(store, new Set(['reviewer'])), {
    accountId: 'acc_rev',
    appealId: created.view.id,
  });
  assert.equal(officialRead.view.id, created.view.id);
  // CG-F004: a stranger must get the same 404 conceal as a missing appeal —
  // 403 here would turn the endpoint into an existence oracle.
  await assert.rejects(
    () => getModerationAppeal(queryPorts(store, new Set()), {
      accountId: STRANGER.accountId,
      appealId: created.view.id,
    }),
    (error: unknown) => error instanceof GovernanceModerationError
      && error.code === 'resource_not_found'
      && error.outcome === 'conceal',
  );
});

test('fresh command on a terminal appeal is revision_conflict', async () => {
  const store = memoryStore([actionRecord('act_hide', 'hide_public')]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'please restore' });
  const created = await createModerationAppeal(commandPorts(store, new Set()), {
    actor: OWNER,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
    commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
    body,
  });
  assert.equal(created.kind, 'written');
  if (created.kind !== 'written') return;
  const decision = parseAppealDecision({ decision: 'reject', resolution: 'control stands' });
  const decided = await decideModerationAppeal(commandPorts(store, new Set(['moderator'])), {
    actor: MODERATOR,
    commandId: '33333333-3333-4333-8333-333333333333',
    fingerprint: fingerprint('POST', `/api/v1/moderation/appeals/${created.view.id}/decision`, decision, '"1"'),
    commandScope: `http:v1:POST:/api/v1/moderation/appeals/${created.view.id}/decision`,
    appealId: created.view.id,
    ifMatch: '"1"',
    body: decision,
  });
  assert.equal(decided.kind, 'written');
  if (decided.kind !== 'written') return;
  const second = parseAppealDecision({ decision: 'uphold', resolution: 'late change of mind' });
  await assert.rejects(
    () => decideModerationAppeal(commandPorts(store, new Set(['moderator'])), {
      actor: MODERATOR,
      commandId: '44444444-4444-4444-8444-444444444444',
      fingerprint: fingerprint(
        'POST',
        `/api/v1/moderation/appeals/${created.view.id}/decision`,
        second,
        `"${decided.view.revision}"`,
      ),
      commandScope: `http:v1:POST:/api/v1/moderation/appeals/${created.view.id}/decision`,
      appealId: created.view.id,
      ifMatch: `"${decided.view.revision}"`,
      body: second,
    }),
    (error: unknown) => error instanceof GovernanceModerationError && error.code === 'revision_conflict',
  );
  assert.equal(store.actions[0]?.state, 'active');
});

test('reject keeps the appealed action active', async () => {
  const store = memoryStore([actionRecord('act_hide', 'hide_public')]);
  const body = parseAppealInput({ actionId: 'act_hide', description: 'please restore' });
  const created = await createModerationAppeal(commandPorts(store, new Set()), {
    actor: OWNER,
    commandId: '11111111-1111-4111-8111-111111111111',
    fingerprint: fingerprint('POST', '/api/v1/moderation/appeals', body),
    commandScope: 'http:v1:POST:/api/v1/moderation/appeals',
    body,
  });
  assert.equal(created.kind, 'written');
  if (created.kind !== 'written') return;
  const decision = parseAppealDecision({ decision: 'reject', resolution: 'control stands' });
  const decided = await decideModerationAppeal(commandPorts(store, new Set(['moderator'])), {
    actor: MODERATOR,
    commandId: '33333333-3333-4333-8333-333333333333',
    fingerprint: fingerprint('POST', `/api/v1/moderation/appeals/${created.view.id}/decision`, decision, '"1"'),
    commandScope: `http:v1:POST:/api/v1/moderation/appeals/${created.view.id}/decision`,
    appealId: created.view.id,
    ifMatch: '"1"',
    body: decision,
  });
  assert.equal(decided.kind, 'written');
  assert.equal(store.actions[0]?.state, 'active');
});

test('governance collection control still has one consumer name and no appeal event type', () => {
  const routes = createGovernanceCollectionControlRoutes({
    provider: { async purge() {} },
    publicationOrigin: 'https://pub.example.test',
    productOrigin: 'https://app.example.test',
  });
  assert.equal(new Set(routes.map((route) => route.handlerName)).size, 1);
  assert.equal(routes[0]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
  assert.equal(routes.some((route) => route.eventType.includes('appeal')), false);
});
