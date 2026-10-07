import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import {
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
} from '../../src/modules/collections/index.js';
import type { DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  type PostgresCanonicalMutationFaultContext,
} from '../../src/infrastructure/collections/index.js';
import { createPhase4bMcpLowRiskNodeCreateInspect } from '../../src/bootstrap/mcp-write-composition.js';
import {
  truncateFixtureTables,
} from './postgres-test-runtime.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  createPhase4bMcpLowRiskNodeCreateService,
  type Phase4bMcpLowRiskNodeCreateCompleteOutput,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateOutput,
  type Phase4bMcpLowRiskNodeCreateRequest,
} from '../../src/modules/mcp/low-risk-node-create.js';

export const PRINCIPAL_ID = 'BgYGBgYGBgYGBgYGBgYGBg';
export const EDITOR_PRINCIPAL_ID = 'CAgICAgICAgICAgIC';
export const COLLECTION_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
export const ROOT_ID = 'AgICAgICAgICAgIC';
export const FIXTURE_COMMAND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const FIXTURE_OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: PRINCIPAL_ID,
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

export const CONTEXT: Phase4bMcpLowRiskNodeCreateContext = Object.freeze({
  binding: BINDING,
  accountSubjectId: BINDING.principalId,
  scope: Object.freeze(['nodes:write']),
});

export const CATALOG_INPUT = Object.freeze({
  tool: 'nodes.create',
  collectionId: COLLECTION_ID,
  parentId: ROOT_ID,
  afterId: null,
  beforeId: null,
  node: Object.freeze({
    kind: 'bookmark',
    title: 'W04 bookmark',
    url: 'https://example.test/w04',
    description: null,
    tags: Object.freeze(['w04']),
    visibility: 'private',
  }),
  reason: 'create a bookmark',
  confirmApply: true,
});

export interface FixtureFacts {
  readonly collectionId: string;
  readonly rootId: string;
  readonly rootChildrenRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
}

export interface CanonicalCounts {
  readonly nodes: number;
  readonly operations: number;
  readonly audits: number;
  readonly outbox: number;
  readonly receipts: number;
  readonly resourceRevisions: number;
  readonly contentRevisions: number;
  readonly childrenRevisions: number;
  readonly resourceIdLedger: number;
}


export function createW04PostgresHarness(getRuntime: () => DatabaseRuntime) {
  function runtime(): DatabaseRuntime {
    return getRuntime();
  }

  async function resetFixture(): Promise<void> {
    await truncateFixtureTables(runtime().pool, `truncate table product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      profiles, accounts cascade`);
    await runtime().pool.query(
      `insert into accounts(id, subject_id, status, security_epoch)
       values ($1, $1, 'active', 0)`,
      [PRINCIPAL_ID],
    );
    await runtime().pool.query(
      `insert into profiles(account_id, display_name, avatar_url)
       values ($1, 'MCP W04 owner', null)`,
      [PRINCIPAL_ID],
    );
  }

  async function createFixture(): Promise<FixtureFacts> {
    await resetFixture();
    const input: CreateOwnedCollectionInput = {
      actor: {
        principalId: PRINCIPAL_ID,
        principalType: 'account',
        subjectId: PRINCIPAL_ID,
      },
      command: {
        commandId: FIXTURE_COMMAND_ID,
        fingerprint: 'fixture-collection-fingerprint',
      },
      title: 'MCP W04 Collection',
      summary: null,
      kind: 'bookmarks',
      collectionId: COLLECTION_ID,
      rootNodeId: ROOT_ID,
      operationId: FIXTURE_OPERATION_ID,
    };
    const result = await createPostgresCanonicalMutationUnitOfWork(runtime().db).execute((ports) =>
      createOwnedCollectionCanonical(ports, input));
    assert.equal(result.kind, 'created');
    const collection = (await runtime().pool.query(
      'select content_revision, policy_revision from collections where id = $1',
      [COLLECTION_ID],
    )).rows[0];
    const root = (await runtime().pool.query(
      'select children_revision from nodes where id = $1',
      [ROOT_ID],
    )).rows[0];
    return {
      collectionId: COLLECTION_ID,
      rootId: ROOT_ID,
      rootChildrenRevision: root.children_revision,
      contentRevision: collection.content_revision,
      policyRevision: collection.policy_revision,
    };
  }

  function request(
    fixture: FixtureFacts,
    options: {
      readonly idempotencyKey?: string;
      readonly inputOverrides?: Readonly<Record<string, unknown>>;
      readonly expectedBaseRevisions?: Readonly<Record<string, string>>;
    } = {},
  ): Phase4bMcpLowRiskNodeCreateRequest {
    return Object.freeze({
      input: Object.freeze({
        ...CATALOG_INPUT,
        ...options.inputOverrides,
      }),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      expectedBaseRevisions: options.expectedBaseRevisions ?? Object.freeze({
        [`children.${fixture.rootId}`]: fixture.rootChildrenRevision,
        [`content.${fixture.collectionId}`]: fixture.contentRevision,
        [`policy.${fixture.collectionId}`]: fixture.policyRevision,
      }),
    });
  }

  function service(options: {
    readonly canonicalFaultInjector?: {
      afterPhase(context: PostgresCanonicalMutationFaultContext): void | Promise<void>;
    };
  } = {}) {
    const unitOfWork = createPostgresCanonicalMutationUnitOfWork(runtime().db, options);
    return createPhase4bMcpLowRiskNodeCreateService({
      unitOfWork,
      inspect: createPhase4bMcpLowRiskNodeCreateInspect(runtime().db),
    });
  }

  async function counts(): Promise<CanonicalCounts> {
    const result = await runtime().pool.query<CanonicalCounts>(`select
      (select count(*)::int from nodes) nodes,
      (select count(*)::int from operations) operations,
      (select count(*)::int from audit_events) audits,
      (select count(*)::int from outbox_events) outbox,
      (select count(*)::int from product_command_receipts) receipts,
      (select count(*)::int from resource_revisions) as "resourceRevisions",
      (select count(*)::int from content_revisions) as "contentRevisions",
      (select count(*)::int from children_revisions) as "childrenRevisions",
      (select count(*)::int from resource_id_ledger) as "resourceIdLedger"`);
    return result.rows[0]!;
  }

  async function assertW04Error(
    promise: Promise<unknown>,
    code: Phase4bMcpLowRiskNodeCreateError['code'],
  ): Promise<void> {
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
      assert.equal(error.code, code);
      return true;
    });
  }

  function requireComplete(
    output: Phase4bMcpLowRiskNodeCreateOutput,
  ): Phase4bMcpLowRiskNodeCreateCompleteOutput {
    assert.equal(output.resultType, 'complete');
    if (output.resultType !== 'complete') {
      throw new Error('expected complete nodes.create output');
    }
    return output;
  }

  function previewRequest(
    fixture: FixtureFacts,
    options: {
      readonly idempotencyKey?: string;
      readonly expectedBaseRevisions?: Readonly<Record<string, string>>;
    } = {},
  ): Phase4bMcpLowRiskNodeCreateRequest {
    const { confirmApply: _confirmApply, ...base } = CATALOG_INPUT;
    void _confirmApply;
    return Object.freeze({
      input: Object.freeze({
        ...base,
        dryRun: true,
        confirmApply: false,
      }),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      expectedBaseRevisions: options.expectedBaseRevisions ?? Object.freeze({
        [`children.${fixture.rootId}`]: fixture.rootChildrenRevision,
        [`content.${fixture.collectionId}`]: fixture.contentRevision,
        [`policy.${fixture.collectionId}`]: fixture.policyRevision,
      }),
    });
  }

  return {
    createFixture,
    request,
    service,
    counts,
    assertW04Error,
    requireComplete,
    previewRequest,
  };
}
