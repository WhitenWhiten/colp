import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  AUTHORITATIVE_STATE_UNAVAILABLE_MESSAGE,
  createAuthoritativeState,
  createAuthorizationPolicy,
  createMcpChangePlanRateLimitPort,
  createPhase4bMcpWriteComposition,
} from '../../../src/bootstrap/mcp-write-composition.js';
import { runWithMcpAccountSubjectId } from '../../../src/modules/mcp/account-context.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'epoch-1',
});

const fakeDb = {} as Parameters<typeof createPhase4bMcpWriteComposition>[0]['db'];

test('MCP-W10 write composition rejects a missing rateLimit instead of allowing all', () => {
  const options = {
    db: fakeDb,
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
  } as Parameters<typeof createPhase4bMcpWriteComposition>[0];

  assert.throws(
    () => createPhase4bMcpWriteComposition(options),
    /rateLimit/u,
  );
});

test('MCP-W10 commit rate port rejects unbounded or invalid options', () => {
  assert.throws(
    () => createMcpChangePlanRateLimitPort({ maxPlans: 0, windowMs: 60_000 }),
    /positive safe integer/u,
  );
  assert.throws(
    () => createMcpChangePlanRateLimitPort({ maxPlans: 10_001, windowMs: 60_000 }),
    /maxPlans must be <= 10000/u,
  );
  assert.throws(
    () => createMcpChangePlanRateLimitPort({ maxPlans: 1, windowMs: 3_600_001 }),
    /windowMs must be <= 3600000/u,
  );
});

test('MCP-W10 commit rate port counts distinct Plans per binding and deduplicates MRTR retries', async () => {
  let now = 1_000;
  const composition = createPhase4bMcpWriteComposition({
    db: fakeDb,
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: createMcpChangePlanRateLimitPort({
      maxPlans: 2,
      windowMs: 60_000,
      now: () => now,
    }),
  });
  const rateLimit = composition.changePlanOptions.rateLimit;

  assert.equal(await rateLimit.allow({ planId: 'plan-1', binding: BINDING }), true);
  assert.equal(await rateLimit.allow({ planId: 'plan-1', binding: BINDING }), true);
  assert.equal(await rateLimit.allow({ planId: 'plan-2', binding: BINDING }), true);
  assert.equal(await rateLimit.allow({ planId: 'plan-3', binding: BINDING }), false);

  const otherBinding = Object.freeze({ ...BINDING, principalId: 'principal-2' });
  assert.equal(await rateLimit.allow({ planId: 'plan-3', binding: otherBinding }), true);

  now += 60_000;
  assert.equal(await rateLimit.allow({ planId: 'plan-3', binding: BINDING }), true);
});

test('MCP-W10 write composition propagates the injected rate limit port', () => {
  const injected = Object.freeze({
    async allow() {
      return true;
    },
  });
  const composition = createPhase4bMcpWriteComposition({
    db: fakeDb,
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: injected,
  });

  assert.equal(composition.changePlanOptions.rateLimit, injected);
});

test('MCP-W10 write composition exposes exactly one change-plan-service coordinator', () => {
  const composition = createPhase4bMcpWriteComposition({
    db: fakeDb,
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 2, windowMs: 60_000 }),
  });

  // FIX-M-016: the composition must not construct a second (wire) coordinator;
  // the adapter, the host service, and the composition all share the single
  // change-plan-service coordinator object and its canonical executor.
  assert.ok(composition.commitCoordinator);
  assert.equal(
    composition.changePlanOptions.commitCoordinator,
    composition.commitCoordinator,
  );
  assert.equal(
    composition.changePlanService.commitCoordinator,
    composition.commitCoordinator,
  );
  assert.equal(typeof composition.commitCoordinator.executor.execute, 'function');
});

const OWNER_ACCOUNT_ID = 'acct_owner_ta5_000000000001';
const OWNER_SUBJECT_ID = 'subj_owner_ta5_000000000001';
const STRANGER_ACCOUNT_ID = 'acct_stranger_ta5_0000000001';
const STRANGER_SUBJECT_ID = 'subj_stranger_ta5_0000000001';
const COLLECTION_ID = 'col_ta5_owner_collection';
const PARENT_ID = 'node_ta5_owner_root';
const NODE_ID = 'node_ta5_owner_item';
const CONTENT_REVISION = 'content-r1';
const CHILDREN_REVISION = 'children-r1';
const RESOURCE_REVISION = 'resource-r1';
const COLLECTION_RESOURCE_REVISION = 'collection-res-r1';
const POLICY_REVISION = 'policy-r1';

function ownerBinding(): McpAuthenticatedAuthorizationBinding {
  return Object.freeze({ ...BINDING, principalId: OWNER_ACCOUNT_ID });
}

function strangerBinding(): McpAuthenticatedAuthorizationBinding {
  return Object.freeze({ ...BINDING, principalId: STRANGER_ACCOUNT_ID });
}

function createPlanningDb(seed: {
  readonly collection?: {
    readonly id: string;
    readonly title: string;
    readonly owner_subject_id: string;
    readonly visibility: string;
    readonly policy_revision: string;
    readonly content_revision: string;
    readonly resource_revision: string;
    readonly deleted_at: Date | null;
  };
  readonly nodes?: readonly {
    readonly id: string;
    readonly collection_id: string;
    readonly children_revision: string;
    readonly resource_revision: string;
    readonly deleted_at: Date | null;
  }[];
  readonly members?: readonly {
    readonly collection_id: string;
    readonly subject_id: string;
    readonly role: string;
  }[];
}): Parameters<typeof createAuthoritativeState>[0] {
  const matches = (row: Record<string, unknown>, filters: readonly {
    readonly col: string;
    readonly op: string;
    readonly val: unknown;
  }[]) => filters.every((filter) => {
    if (filter.op === '=') return row[filter.col] === filter.val;
    if (filter.op === 'is' && filter.val === null) return row[filter.col] == null;
    return false;
  });
  const executor = {
    selectFrom(table: string) {
      const filters: Array<{ col: string; op: string; val: unknown }> = [];
      const builder = {
        select() { return builder; },
        where(col: string, op: string, val: unknown) {
          filters.push({ col, op, val });
          return builder;
        },
        async executeTakeFirst() {
          if (table === 'collections' && seed.collection && matches(
            seed.collection as unknown as Record<string, unknown>,
            filters,
          )) {
            return seed.collection;
          }
          if (table === 'nodes') {
            return seed.nodes?.find((node) => matches(
              node as unknown as Record<string, unknown>,
              filters,
            ));
          }
          if (table === 'collection_members') {
            return seed.members?.find((member) => matches(
              member as unknown as Record<string, unknown>,
              filters,
            ));
          }
          return undefined;
        },
        async execute() {
          if (table === 'nodes') {
            return seed.nodes?.filter((node) => matches(
              node as unknown as Record<string, unknown>,
              filters,
            )) ?? [];
          }
          return [];
        },
      };
      return builder;
    },
  };
  return {
    ...executor,
    transaction() {
      return {
        setIsolationLevel() { return this; },
        execute: async (work: (trx: typeof executor) => unknown) => work(executor),
      };
    },
  } as unknown as Parameters<typeof createAuthoritativeState>[0];
}

function ownedSeed() {
  return {
    collection: {
      id: COLLECTION_ID,
      title: 'Owner collection',
      owner_subject_id: OWNER_SUBJECT_ID,
      visibility: 'private',
      policy_revision: POLICY_REVISION,
      content_revision: CONTENT_REVISION,
      resource_revision: COLLECTION_RESOURCE_REVISION,
      deleted_at: null,
    },
    nodes: [
      {
        id: PARENT_ID,
        collection_id: COLLECTION_ID,
        children_revision: CHILDREN_REVISION,
        resource_revision: 'resource-root-r1',
        deleted_at: null,
      },
      {
        id: NODE_ID,
        collection_id: COLLECTION_ID,
        children_revision: 'children-item-r1',
        resource_revision: RESOURCE_REVISION,
        deleted_at: null,
      },
    ],
    members: [
      {
        collection_id: COLLECTION_ID,
        subject_id: OWNER_SUBJECT_ID,
        role: 'owner',
      },
    ],
  };
}

function isConcealedAuthoritativeError(error: unknown): boolean {
  return error instanceof Error
    && error.message === AUTHORITATIVE_STATE_UNAVAILABLE_MESSAGE
    && !error.message.includes('disappeared')
    && !error.message.includes(CONTENT_REVISION)
    && !error.message.includes(CHILDREN_REVISION)
    && !error.message.includes(RESOURCE_REVISION)
    && !error.message.includes(COLLECTION_RESOURCE_REVISION)
    && !error.message.includes(POLICY_REVISION);
}

test('MCP-W10 createAuthoritativeState plans for members using account subject, not binding.principalId', async () => {
  const state = createAuthoritativeState(createPlanningDb(ownedSeed()));
  const revisions = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
    state.resolveCreateBaseRevisions(
      { collectionId: COLLECTION_ID, parentId: PARENT_ID },
      ownerBinding(),
    ));
  assert.deepEqual(revisions, {
    parentChildrenRevision: CHILDREN_REVISION,
    collectionContentRevision: CONTENT_REVISION,
    collectionVisibility: 'private',
  });
});

test('MCP-W10 createAuthoritativeState conceals non-members identically to missing resources', async () => {
  const state = createAuthoritativeState(createPlanningDb(ownedSeed()));
  const createInput = { collectionId: COLLECTION_ID, parentId: PARENT_ID };
  const missingInput = { collectionId: 'col_ta5_missing_collection', parentId: 'node_ta5_missing_parent' };

  const unauthorizedError = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
    try {
      await state.resolveCreateBaseRevisions(createInput, strangerBinding());
      throw new Error('expected non-member create planning to fail');
    } catch (error) {
      return error;
    }
  });
  const missingError = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
    try {
      await state.resolveCreateBaseRevisions(missingInput, strangerBinding());
      throw new Error('expected missing create planning to fail');
    } catch (error) {
      return error;
    }
  });
  const visibilityUnauthorized = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
    try {
      await state.resolveVisibilityFacts(
        { collectionId: COLLECTION_ID, nodeId: NODE_ID },
        strangerBinding(),
      );
      throw new Error('expected non-member visibility planning to fail');
    } catch (error) {
      return error;
    }
  });

  assert.ok(isConcealedAuthoritativeError(unauthorizedError));
  assert.ok(isConcealedAuthoritativeError(missingError));
  assert.ok(isConcealedAuthoritativeError(visibilityUnauthorized));
  assert.equal((unauthorizedError as Error).message, (missingError as Error).message);
  assert.equal((unauthorizedError as Error).name, (missingError as Error).name);
});

test('MCP-W10 revision port conceals set_visibility facts from non-members', async () => {
  const composition = createPhase4bMcpWriteComposition({
    db: createPlanningDb(ownedSeed()) as Parameters<typeof createPhase4bMcpWriteComposition>[0]['db'],
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 2, windowMs: 60_000 }),
  });
  const operation = Object.freeze({
    type: 'set_visibility',
    collectionId: COLLECTION_ID,
    baseRevision: RESOURCE_REVISION,
    input: Object.freeze({ visibility: 'protected' }),
  });

  const allowed = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
    composition.changePlanOptions.revisions.resolveBaseRevisions(operation, ownerBinding()));
  assert.equal(allowed[`node.${NODE_ID}`], RESOURCE_REVISION);
  assert.equal(allowed[`policy.${COLLECTION_ID}`], POLICY_REVISION);

  const concealed = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
    try {
      await composition.changePlanOptions.revisions.resolveBaseRevisions(
        operation,
        strangerBinding(),
      );
      throw new Error('expected non-member revision lookup to fail');
    } catch (error) {
      return error;
    }
  });
  assert.ok(isConcealedAuthoritativeError(concealed));
  assert.doesNotMatch((concealed as Error).message, new RegExp(NODE_ID, 'u'));
});

test('MCP-W10 revision port maps collection public visibility onto resource and policy fences', async () => {
  const composition = createPhase4bMcpWriteComposition({
    db: createPlanningDb(ownedSeed()) as Parameters<typeof createPhase4bMcpWriteComposition>[0]['db'],
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 2, windowMs: 60_000 }),
  });
  const operation = Object.freeze({
    type: 'set_visibility',
    collectionId: COLLECTION_ID,
    baseRevision: COLLECTION_RESOURCE_REVISION,
    input: Object.freeze({ visibility: 'public' }),
  });

  const allowed = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, () =>
    composition.changePlanOptions.revisions.resolveBaseRevisions(operation, ownerBinding()));
  assert.equal(allowed[`resource.${COLLECTION_ID}`], COLLECTION_RESOURCE_REVISION);
  assert.equal(allowed[`policy.${COLLECTION_ID}`], POLICY_REVISION);
  assert.equal(Object.hasOwn(allowed, `node.${NODE_ID}`), false);

  const concealed = await runWithMcpAccountSubjectId(STRANGER_SUBJECT_ID, async () => {
    try {
      await composition.changePlanOptions.revisions.resolveBaseRevisions(
        operation,
        strangerBinding(),
      );
      throw new Error('expected non-member collection visibility lookup to fail');
    } catch (error) {
      return error;
    }
  });
  assert.ok(isConcealedAuthoritativeError(concealed));
});

test('MCP-W10 revision port does not treat a node fence as collection public visibility', async () => {
  const composition = createPhase4bMcpWriteComposition({
    db: createPlanningDb(ownedSeed()) as Parameters<typeof createPhase4bMcpWriteComposition>[0]['db'],
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    approvalBaseUri: 'https://app.example.test/approvals',
    requestStateKey: Buffer.alloc(32, 77).toString('base64'),
    rateLimit: createMcpChangePlanRateLimitPort({ maxPlans: 2, windowMs: 60_000 }),
  });
  const failed = await runWithMcpAccountSubjectId(OWNER_SUBJECT_ID, async () => {
    try {
      await composition.changePlanOptions.revisions.resolveBaseRevisions(
        Object.freeze({
          type: 'set_visibility',
          collectionId: COLLECTION_ID,
          baseRevision: RESOURCE_REVISION,
          input: Object.freeze({ visibility: 'public' }),
        }),
        ownerBinding(),
      );
      throw new Error('expected node fence public visibility to fail closed');
    } catch (error) {
      return error;
    }
  });
  assert.ok(isConcealedAuthoritativeError(failed));
});


test('MCP-W10 server policy maps every canonical Change Plan operation to a scope', async () => {
  const policy = createAuthorizationPolicy();
  const cases = [
    ['create_node', ['nodes:write']],
    ['move_node', ['nodes:write']],
    ['delete_subtree', ['nodes:delete']],
    ['set_visibility', ['access:write']],
    ['set_access_policy', ['access:write']],
    ['delete_collection', ['collections:delete']],
    ['create_key', ['keys:write']],
    ['rotate_key', ['keys:write']],
    ['revoke_key', ['keys:write']],
    ['set_rate_limit', ['rate_limits:write']],
    ['publish_release', ['release:publish']],
    ['sync_mirror', ['sync:push']],
  ] as const;

  for (const [type, expected] of cases) {
    assert.deepEqual(
      await policy.requiredScopesForOperation({ type }),
      expected,
    );
  }
});
