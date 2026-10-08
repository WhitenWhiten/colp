/** Shared MCP-W04 unit-test UoW fakes. Not a test file. */
import assert from 'node:assert/strict';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type {
  CreateCollectionNodeResult,
  EditableNodeView,
  ProductCollectionCanonicalPorts,
  ProductCollectionMutationUnitOfWork,
} from '../../src/modules/collections/index.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  createPhase4bMcpLowRiskNodeCreateService,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateInspectPorts,
} from '../../src/modules/mcp/low-risk-node-create.js';

export const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

export const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';

export const CATALOG_NODE = Object.freeze({
  kind: 'bookmark',
  title: 'Example bookmark',
  url: 'https://example.com',
  description: null,
  tags: Object.freeze([]),
  visibility: 'private',
});

export const CATALOG_BASE = Object.freeze({
  tool: 'nodes.create',
  collectionId: 'collection-1',
  parentId: 'root-1',
  afterId: null,
  beforeId: null,
  node: CATALOG_NODE,
  reason: 'create a bookmark',
});

export const CATALOG_INPUT = Object.freeze({
  ...CATALOG_BASE,
  confirmApply: true,
});

export const PREVIEW_CATALOG_INPUT = Object.freeze({
  ...CATALOG_BASE,
  dryRun: true,
  confirmApply: false,
});

export const REQUEST = Object.freeze({
  input: CATALOG_INPUT,
  idempotencyKey: IDEMPOTENCY_KEY,
  expectedBaseRevisions: Object.freeze({
    'children.root-1': 'children-r1',
    'content.collection-1': 'content-r1',
    'policy.collection-1': 'policy-r1',
  }),
});

export const PREVIEW_REQUEST = Object.freeze({
  input: PREVIEW_CATALOG_INPUT,
  idempotencyKey: IDEMPOTENCY_KEY,
  expectedBaseRevisions: REQUEST.expectedBaseRevisions,
});

export const CONTEXT: Phase4bMcpLowRiskNodeCreateContext = Object.freeze({
  binding: BINDING,
  accountSubjectId: BINDING.principalId,
  scope: Object.freeze(['nodes:write']),
});

export const PARENT = Object.freeze({
  id: 'root-1',
  childrenRevision: 'children-r2',
  childrenEtag: '"children-r2"',
});

export const FENCE = Object.freeze({
  contentRevision: 'content-r2',
  contentEtag: '"content-r2"',
  policyRevision: 'policy-r2',
  policyEtag: '"policy-r2"',
});

export function nodeView(): EditableNodeView {
  return Object.freeze({
    id: 'node-1',
    collectionId: 'collection-1',
    parentId: 'root-1',
    kind: 'bookmark',
    title: 'Example bookmark',
    url: 'https://example.com',
    description: null,
    tags: Object.freeze([]),
    visibility: 'private',
    position: 'E',
    revision: 'resource-r2',
    etag: '"resource-r2"',
    readOnly: false,
    readOnlyReason: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
    iconUrl: null,
  }) as unknown as EditableNodeView;
}

export function createdResult(): CreateCollectionNodeResult {
  return Object.freeze({
    kind: 'created',
    node: nodeView(),
    parent: PARENT,
    fence: FENCE,
    operationId: 'operation-1',
    commitOrdinal: 2n,
  });
}

export function replayResult(): CreateCollectionNodeResult {
  const body = Buffer.from(JSON.stringify({
    node: nodeView(),
    parent: PARENT,
    fence: FENCE,
  }));
  return Object.freeze({
    kind: 'replay',
    status: 201,
    body,
    stableHeaders: Object.freeze({
      location: '/api/v1/collections/collection-1/nodes/node-1',
      etag: '"resource-r2"',
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    }),
    mediaType: 'application/json',
    contractVersion: '1.0.0',
    targetIdentity: 'node-1',
  });
}

export interface UowProbe {
  callbackInvoked: boolean;
  claimCalls: number;
  lockCalls: number;
  loadFactsCalls: number;
  canonicalExecuteCalls: number;
  underlyingClaimSettled: boolean;
  interceptorCurrentStateReached: boolean;
}

export function createUowProbe(): UowProbe {
  return {
    callbackInvoked: false, claimCalls: 0, lockCalls: 0, loadFactsCalls: 0,
    canonicalExecuteCalls: 0,
    underlyingClaimSettled: false, interceptorCurrentStateReached: false,
  };
}

function unusedPort(name: string) {
  return async () => { throw new Error(`${name} is unused by the MCP-W04 unit-test UoW fake`); };
}

function claimForResult(result: CreateCollectionNodeResult) {
  if (result.kind === 'created') return { kind: 'claimed' as const };
  if (result.kind === 'replay') {
    return {
      kind: 'replay' as const,
      result: {
        status: result.status, body: result.body, stableHeaders: result.stableHeaders,
        mediaType: result.mediaType, contractVersion: result.contractVersion,
        targetIdentity: result.targetIdentity,
      },
    };
  }
  if (result.kind === 'in_progress') {
    return { kind: 'in_progress' as const, retryAfterSeconds: result.retryAfterSeconds };
  }
  if (result.kind === 'reused') return { kind: 'reused' as const };
  return { kind: 'expired' as const, resultDigest: result.resultDigest };
}

export function createFakePorts(
  result: CreateCollectionNodeResult,
  probe: UowProbe,
  fakeOptions: {
    readonly parentChildrenRevision?: string;
    readonly collectionVisibility?: 'private' | 'protected' | 'unlisted' | 'public';
  } = {},
): ProductCollectionCanonicalPorts {
  const parentChildrenRevision = fakeOptions.parentChildrenRevision ?? 'children-r1';
  const collectionVisibility = fakeOptions.collectionVisibility ?? 'private';
  const now = new Date('2026-08-05T12:00:00.000Z');
  return {
    receipts: {
      claim: async () => {
        probe.claimCalls += 1;
        const claim = claimForResult(result);
        probe.underlyingClaimSettled = true;
        return claim;
      },
      complete: async () => undefined,
    },
    clock: {
      now: async () => now,
    },
    collections: {
      lockForUpdate: async (collectionId) => {
        probe.lockCalls += 1;
        if (probe.underlyingClaimSettled) {
          probe.interceptorCurrentStateReached = true;
        }
        if (collectionId !== CATALOG_INPUT.collectionId) return null;
        return {
          id: CATALOG_INPUT.collectionId,
          ownerSubjectId: BINDING.principalId,
          title: 'Collection',
          summary: null,
          kind: 'bookmarks',
          visibility: collectionVisibility,
          rootNodeId: CATALOG_INPUT.parentId,
          resourceRevision: 'resource-r1',
          contentRevision: 'content-r1',
          policyRevision: 'policy-r1',
          commitOrdinal: 1n,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
      },
    },
    nodes: {
      getNode: async (collectionId, nodeId) => {
        if (collectionId !== CATALOG_INPUT.collectionId || nodeId !== CATALOG_INPUT.parentId) {
          return null;
        }
        return {
          id: CATALOG_INPUT.parentId,
          collectionId,
          parentId: null,
          kind: 'folder',
          isRoot: true,
          title: 'Root',
          url: null,
          description: null,
          tags: [],
          visibility: 'inherit',
          positionToken: 'A',
          resourceRevision: 'resource-r1',
          childrenRevision: parentChildrenRevision,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
      },
      listLiveSiblingPositions: unusedPort('nodes.listLiveSiblingPositions'),
    },
    accessPolicy: {
      loadCollectionFacts: async () => {
        probe.loadFactsCalls += 1;
        return {
          collectionId: CATALOG_INPUT.collectionId,
          ownerSubjectId: BINDING.principalId,
          visibility: 'private',
          policyRevision: 'policy-r1',
          membershipRole: 'owner',
          deleted: false,
        };
      },
    },
    canonical: {
      execute: async (input) => {
        probe.canonicalExecuteCalls += 1;
        if (result.kind !== 'created') {
          throw new Error('canonical.execute is only used on the claimed create path');
        }
        return {
          operationId: input.operationId,
          collectionId: input.collectionId,
          resourceId: input.mutation.target.resourceId,
          action: 'create',
          allocation: {
            commitOrdinal: result.commitOrdinal,
            resourceRevision: result.node.revision,
            createdNodeChildrenRevision: 'children-new',
            contentRevision: result.fence.contentRevision,
            policyRevision: result.fence.policyRevision,
            childrenRevisions: {
              [input.mutation.parentId!]: result.parent.childrenRevision,
            },
            positionToken: result.node.position,
          },
        };
      },
      bootstrapOwnedCollection: unusedPort('canonical.bootstrapOwnedCollection'),
    },
  };
}

export function createInvokingUnitOfWork(
  result: CreateCollectionNodeResult,
  probe: UowProbe,
  fakeOptions: {
    readonly parentChildrenRevision?: string;
    readonly collectionVisibility?: 'private' | 'protected' | 'unlisted' | 'public';
  } = {},
): ProductCollectionMutationUnitOfWork {
  return Object.freeze({
    execute: async (work: (ports: ProductCollectionCanonicalPorts) => Promise<unknown>) => {
      probe.callbackInvoked = true;
      if (typeof work !== 'function') {
        throw new TypeError('unitOfWork.execute must invoke the production callback');
      }
      return work(createFakePorts(result, probe, fakeOptions));
    },
  });
}

type CanonicalExecuteInput = Parameters<
  ProductCollectionCanonicalPorts['canonical']['execute']
>[0];

export type CapturedCreateKindFields =
  CanonicalExecuteInput['mutation']['fields']['kindFields'];

export interface DirectCreateCapture {
  kindFields?: CapturedCreateKindFields;
}

/**
 * Direct `nodes.create` service whose product ports record the resolved
 * `kindFields` handed to the canonical mutation. Both the direct tool entry
 * and an approved Plan commit funnel through the same `executeMcpNodeCreate`
 * core, so this capture pins what that shared core actually resolves.
 */
export function createCapturingService(
  result: CreateCollectionNodeResult,
  fakeOptions: {
    readonly parentChildrenRevision?: string;
    readonly collectionVisibility?: 'private' | 'protected' | 'unlisted' | 'public';
  } = {},
): {
  readonly service: ReturnType<typeof createPhase4bMcpLowRiskNodeCreateService>;
  readonly probe: UowProbe;
  readonly capture: DirectCreateCapture;
} {
  const probe = createUowProbe();
  const ports = createFakePorts(result, probe, fakeOptions);
  const capture: DirectCreateCapture = {};
  const unitOfWork: ProductCollectionMutationUnitOfWork = Object.freeze({
    execute: async (work) => {
      probe.callbackInvoked = true;
      return work(Object.freeze({
        ...ports,
        canonical: Object.freeze({
          ...ports.canonical,
          execute: async (input: CanonicalExecuteInput) => {
            capture.kindFields = input.mutation.fields.kindFields;
            return ports.canonical.execute(input);
          },
        }),
      }));
    },
  });
  return {
    service: createPhase4bMcpLowRiskNodeCreateService({ unitOfWork }),
    probe,
    capture,
  };
}

export function createService(
  result: CreateCollectionNodeResult,
  fakeOptions: {
    readonly parentChildrenRevision?: string;
    readonly collectionVisibility?: 'private' | 'protected' | 'unlisted' | 'public';
    readonly inspect?: boolean;
  } = {},
) {
  const probe = createUowProbe();
  const inspectPorts = createFakePorts(result, probe, fakeOptions);
  const inspect = fakeOptions.inspect === false
    ? undefined
    : Object.freeze({
      execute: <Result>(
        work: (ports: Phase4bMcpLowRiskNodeCreateInspectPorts) => Promise<Result>,
      ) => work(Object.freeze({
        getCollection: (collectionId: string) => inspectPorts.collections.lockForUpdate(collectionId),
        getNode: (collectionId: string, nodeId: string) => inspectPorts.nodes.getNode(collectionId, nodeId),
        accessPolicy: inspectPorts.accessPolicy,
      })),
    });
  return Object.freeze({
    service: createPhase4bMcpLowRiskNodeCreateService({
      unitOfWork: createInvokingUnitOfWork(result, probe, fakeOptions),
      ...(inspect === undefined ? {} : { inspect }),
    }),
    probe,
  });
}

export function service(result: CreateCollectionNodeResult) {
  return createService(result).service;
}

export function assertW04Error(
  error: unknown,
  code: Phase4bMcpLowRiskNodeCreateError['code'],
): asserts error is Phase4bMcpLowRiskNodeCreateError {
  assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
  assert.equal(error.code, code);
}

