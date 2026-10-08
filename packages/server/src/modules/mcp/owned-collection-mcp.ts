/**
 * Low-friction MCP owned-collection tools: list private libraries and create
 * a private Collection. Shared by strict and compat facades. Create reuses
 * `createOwnedCollectionCanonical`; list reuses `getOwnedCollectionsPage`.
 * Neither invents a user-visible OAuth scope beyond `mcp:read:own` /
 * `nodes:write`.
 */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
} from '@know-n/colp/mcp';
import { assertCanonicalCommandId, canonicalJson } from '../commands/index.js';
import {
  COLLECTION_KINDS,
  CollectionsError,
  createOwnedCollectionCanonical,
  getOwnedCollectionsPage,
  type CollectionKind,
  OWNED_COLLECTIONS_MAX_LIMIT,
  OwnedCollectionsInputError,
  type GetOwnedCollectionsPagePorts,
  type ProductCollectionMutationUnitOfWork,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpWriteErrorHint,
} from './low-risk-node-create.js';
import { MCP_OAUTH_SCOPE_READ_OWN } from './oauth-verifier.js';

export const PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME = 'collections.list' as const;
export const PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME = 'collections.create' as const;

export const PHASE4B_MCP_COLLECTIONS_LIST_REQUIRED_SCOPES = Object.freeze([
  MCP_OAUTH_SCOPE_READ_OWN,
] as const);

const collectionsListInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    limit: Object.freeze({ type: 'integer', minimum: 1, maximum: OWNED_COLLECTIONS_MAX_LIMIT }),
    cursor: Object.freeze({ type: 'string', minLength: 1 }),
  }),
} as const);

const collectionsListOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    page: Object.freeze({
      type: 'object', additionalProperties: false,
      properties: Object.freeze({
        returnedCount: Object.freeze({ type: 'integer', minimum: 0 }),
        hasMore: Object.freeze({ type: 'boolean' }),
        nextCursor: Object.freeze({ type: Object.freeze(['string', 'null']) }),
      }),
      required: Object.freeze(['returnedCount', 'hasMore', 'nextCursor']),
    }),
    collections: Object.freeze({
      type: 'array',
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({
          id: Object.freeze({ type: 'string', minLength: 1 }),
          title: Object.freeze({ type: 'string' }),
          visibility: Object.freeze({
            type: 'string',
            enum: Object.freeze(['private', 'protected', 'unlisted', 'public']),
          }),
          rootNodeId: Object.freeze({ type: 'string', minLength: 1 }),
          revision: Object.freeze({ type: 'string', minLength: 1 }),
          contentRevision: Object.freeze({ type: 'string', minLength: 1 }),
          policyRevision: Object.freeze({ type: 'string', minLength: 1 }),
        }),
        required: Object.freeze([
          'id',
          'title',
          'visibility',
          'rootNodeId',
          'revision',
          'contentRevision',
          'policyRevision',
        ]),
      }),
    }),
  }),
  required: Object.freeze(['collections', 'page']),
} as const);

export const PHASE4B_MCP_COLLECTIONS_LIST_TOOL: McpApplicationToolDescriptor = Object.freeze({
  name: PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME,
  description:
    'List a bounded page of libraries you own. Continue with page.nextCursor alone; limit is only for the first page. Includes revision (collection resource fence), contentRevision, and policyRevision. Use this for unpublished drafts; resources/list is published public libraries only.',
  inputSchema: collectionsListInputSchema,
  outputSchema: collectionsListOutputSchema,
  requiredScopes: PHASE4B_MCP_COLLECTIONS_LIST_REQUIRED_SCOPES,
});

export const PHASE4B_MCP_COLLECTIONS_CREATE_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    idempotencyKey: Object.freeze({
      type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      description: 'Canonical lowercase UUID v4. Generate a new key for each new collection intent; retain the same key and content for retries.',
    }),
    title: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
    summary: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'null' }),
        Object.freeze({ type: 'string', maxLength: 2_000 }),
      ]),
    }),
    kind: Object.freeze({
      type: 'string',
      enum: COLLECTION_KINDS,
    }),
  }),
  required: Object.freeze(['title', 'idempotencyKey']),
} as const);

export const PHASE4B_MCP_COLLECTIONS_CREATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: Object.freeze({ type: 'string', minLength: 1 }),
    rootNodeId: Object.freeze({ type: 'string', minLength: 1 }),
    title: Object.freeze({ type: 'string' }),
    visibility: Object.freeze({ const: 'private' }),
    revision: Object.freeze({ type: 'string', minLength: 1 }),
    contentRevision: Object.freeze({ type: 'string', minLength: 1 }),
    policyRevision: Object.freeze({ type: 'string', minLength: 1 }),
    rootRevision: Object.freeze({ type: 'string', minLength: 1 }),
    childrenRevision: Object.freeze({ type: 'string', minLength: 1 }),
  }),
  required: Object.freeze([
    'collectionId',
    'rootNodeId',
    'title',
    'visibility',
    'revision',
    'contentRevision',
    'policyRevision',
    'rootRevision',
    'childrenRevision',
  ]),
} as const);

export interface Phase4bMcpOwnedCollectionCreateOutput {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly title: string;
  readonly visibility: 'private';
  readonly revision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly rootRevision: string;
  readonly childrenRevision: string;
}

export interface Phase4bMcpOwnedCollectionCreateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<Phase4bMcpOwnedCollectionCreateOutput>;
}

export function canListOwnedCollectionsTool(
  context: McpApplicationContext,
  ports: GetOwnedCollectionsPagePorts | undefined,
): boolean {
  if (ports === undefined) return false;
  if (context.principal.kind !== 'authenticated') return false;
  return context.scopes.includes(MCP_OAUTH_SCOPE_READ_OWN);
}

export async function callOwnedCollectionsListTool(
  ports: GetOwnedCollectionsPagePorts,
  context: McpApplicationContext,
  input: Readonly<Record<string, unknown>> = {},
): Promise<McpApplicationToolResult> {
  if (!canListOwnedCollectionsTool(context, ports)) {
    return Object.freeze({
      kind: 'rejected',
      stableCode: 'unknown_tool',
      safeMessage: 'Unknown tool.',
      retryable: false,
    });
  }
  if (input.limit !== undefined && typeof input.limit !== 'number'
    || input.cursor !== undefined && typeof input.cursor !== 'string'
    || Object.keys(input).some(key => key !== 'limit' && key !== 'cursor')) {
    throw new OwnedCollectionsInputError('collections.list accepts only limit or cursor');
  }
  const subjectId = requireMcpAccountSubjectId(context.authorization);
  const page = await getOwnedCollectionsPage(ports, {
    actor: { subjectId },
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
  });
  const collections = page.items.map((item) => Object.freeze({
    id: item.id,
    title: item.title,
    visibility: item.visibility,
    rootNodeId: item.rootNodeId,
    revision: item.resourceRevision,
    contentRevision: item.contentRevision,
    policyRevision: item.policyRevision,
  }));
  const structuredContent = Object.freeze({
    collections: Object.freeze(collections),
    page: Object.freeze(page.page),
  });
  return Object.freeze({
    kind: 'complete',
    content: Object.freeze([
      Object.freeze({ type: 'text', text: JSON.stringify(structuredContent) }),
    ]),
    structuredContent,
  });
}

export function createPhase4bMcpOwnedCollectionCreateService(
  options: { readonly unitOfWork: ProductCollectionMutationUnitOfWork },
): Phase4bMcpOwnedCollectionCreateService {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new TypeError('MCP owned-collection create options must be an own-data object.');
  }
  const unitOfWork = options.unitOfWork;
  return Object.freeze({
    execute: async (
      input: Readonly<Record<string, unknown>>,
      context: Phase4bMcpLowRiskNodeCreateContext,
    ) => {
      const binding = requireAuthenticatedWriteBinding(
        snapshotMcpAuthorizationBinding(context.binding),
      );
      const accountSubjectId = requireMcpAccountSubjectId({
        accountSubjectId: context.accountSubjectId,
      });
      const title = readRequiredString(input, 'title');
      const summary = readOptionalSummary(input);
      const kind = readOptionalKind(input);
      const facts = Object.freeze({ title, summary, kind });
      const commandId = readRequiredString(input, 'idempotencyKey');
      try {
        assertCanonicalCommandId(commandId);
      } catch {
        throw new Phase4bMcpLowRiskNodeCreateError('invalid_catalog_input',
          'collections.create idempotencyKey must be a canonical lowercase UUID v4. Use a new key for a new collection; retain it for retries.',
          collectionCreateHint('idempotencyKey'));
      }
      const fingerprint = createHash('sha256').update(canonicalJson(Object.freeze({
        operation: PHASE4B_MCP_COLLECTIONS_CREATE_TOOL_NAME,
        binding: snapshotMcpAuthorizationBinding(binding),
        facts,
      })), 'utf8').digest('hex');
      try {
        const outcome = await unitOfWork.execute((ports) =>
          createOwnedCollectionCanonical(ports, {
            actor: {
              principalId: binding.principalId,
              principalType: 'account',
              subjectId: accountSubjectId,
            },
            command: {
              commandId,
              fingerprint,
            },
            title,
            summary,
            kind,
          }));
        return projectOwnedCollectionCreateOutput(outcome);
      } catch (error) {
        if (error instanceof CollectionsError) {
          throw new Phase4bMcpLowRiskNodeCreateError(
            'policy_denied',
            'collections.create was rejected.',
          );
        }
        throw error;
      }
    },
  });
}

function projectOwnedCollectionCreateOutput(
  outcome: Awaited<ReturnType<typeof createOwnedCollectionCanonical>>,
): Phase4bMcpOwnedCollectionCreateOutput {
  if (outcome.kind === 'created') {
    return Object.freeze({
      collectionId: outcome.collection.id,
      rootNodeId: outcome.collection.rootNodeId,
      title: outcome.collection.title,
      visibility: 'private',
      revision: outcome.collection.revision,
      contentRevision: outcome.collection.contentRevision,
      policyRevision: outcome.collection.policyRevision,
      rootRevision: outcome.root.revision,
      childrenRevision: outcome.root.childrenRevision,
    });
  }
  if (outcome.kind === 'replay') {
    const parsed = decodeReplayCollection(outcome.body);
    return Object.freeze({
      collectionId: parsed.collectionId,
      rootNodeId: parsed.rootNodeId,
      title: parsed.title,
      visibility: 'private',
      revision: parsed.revision,
      contentRevision: parsed.contentRevision,
      policyRevision: parsed.policyRevision,
      rootRevision: parsed.rootRevision,
      childrenRevision: parsed.childrenRevision,
    });
  }
  throw new TypeError('collections.create is not ready to return a Collection.');
}

function decodeReplayCollection(body: Uint8Array): {
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly title: string;
  readonly revision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly rootRevision: string;
  readonly childrenRevision: string;
} {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as {
    readonly collection?: {
      readonly id?: unknown;
      readonly rootNodeId?: unknown;
      readonly title?: unknown;
      readonly revision?: unknown;
      readonly contentRevision?: unknown;
      readonly policyRevision?: unknown;
    };
    readonly root?: {
      readonly revision?: unknown;
      readonly childrenRevision?: unknown;
    };
  };
  const id = parsed.collection?.id;
  const rootNodeId = parsed.collection?.rootNodeId;
  const title = parsed.collection?.title;
  const revision = parsed.collection?.revision;
  const contentRevision = parsed.collection?.contentRevision;
  const policyRevision = parsed.collection?.policyRevision;
  const rootRevision = parsed.root?.revision;
  const childrenRevision = parsed.root?.childrenRevision;
  if (
    typeof id !== 'string'
    || typeof rootNodeId !== 'string'
    || typeof title !== 'string'
    || typeof revision !== 'string'
    || typeof contentRevision !== 'string'
    || typeof policyRevision !== 'string'
    || typeof rootRevision !== 'string'
    || typeof childrenRevision !== 'string'
  ) {
    throw new TypeError('collections.create replay body is missing collection identity.');
  }
  return Object.freeze({
    collectionId: id,
    rootNodeId,
    title,
    revision,
    contentRevision,
    policyRevision,
    rootRevision,
    childrenRevision,
  });
}

function collectionCreateHint(field: string): Phase4bMcpWriteErrorHint {
  return Object.freeze({ field, nextTool: 'collections.create' });
}

function readRequiredString(input: Readonly<Record<string, unknown>>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `collections.create ${name} must be a non-empty string.`,
      collectionCreateHint(name),
    );
  }
  return value;
}

function readOptionalSummary(input: Readonly<Record<string, unknown>>): string | null {
  if (!Object.hasOwn(input, 'summary') || input.summary === null) return null;
  if (typeof input.summary !== 'string') {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'collections.create summary must be a string or null.',
      collectionCreateHint('summary'),
    );
  }
  return input.summary;
}

function readOptionalKind(input: Readonly<Record<string, unknown>>): CollectionKind {
  if (!Object.hasOwn(input, 'kind') || input.kind === undefined) return 'bookmarks';
  if (typeof input.kind !== 'string' || !(COLLECTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      `collections.create kind must be one of: ${COLLECTION_KINDS.join(', ')}.`,
      collectionCreateHint('kind'),
    );
  }
  return input.kind as CollectionKind;
}
