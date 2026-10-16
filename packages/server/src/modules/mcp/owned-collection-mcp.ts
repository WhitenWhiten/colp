/** List the account library; direct agents to create folders with nodes.create. */
import {
  requireAuthenticatedWriteBinding, snapshotMcpAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  ensureLibraryCollection, getOwnedCollectionsPage, OWNED_COLLECTIONS_MAX_LIMIT, OwnedCollectionsInputError,
  type GetOwnedCollectionsPagePorts, type LibraryCollection, type LibraryCollectionUnitOfWork,
} from '../collections/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpLowRiskNodeCreateContext,
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
          library: Object.freeze({ type: 'boolean' }),
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
    'Read your private bookmark library and its rootNodeId. The library is marked library:true. Use nodes.create to create folders inside it.',
  inputSchema: collectionsListInputSchema,
  outputSchema: collectionsListOutputSchema,
  requiredScopes: PHASE4B_MCP_COLLECTIONS_LIST_REQUIRED_SCOPES,
});

/** This retired tool remains discoverable only to explain how to create folders. */
export const PHASE4B_MCP_COLLECTIONS_CREATE_INPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, properties: Object.freeze({}),
} as const);
export const PHASE4B_MCP_COLLECTIONS_CREATE_OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({}) } as const);

export interface Phase4bMcpOwnedCollectionCreateService {
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: Phase4bMcpLowRiskNodeCreateContext,
  ) => Promise<never>;
}

export class LibraryFolderRequiredError extends Error {
  readonly code = 'library_protected' as const;
  constructor(readonly library: LibraryCollection) {
    super(libraryFolderRequiredMessage(library));
    this.name = 'LibraryFolderRequiredError';
  }
}
export function libraryFolderRequiredMessage(library: LibraryCollection): string {
  return `Create a folder in your bookmark library with nodes.create instead. Library: ${library.id}; Bookmarks bar: ${library.bookmarksBarId}; Other bookmarks: ${library.otherBookmarksId}. Choose the parent folder explicitly.`;
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
  if (ports.libraryCollectionUnitOfWork && context.principal.kind === 'authenticated') {
    await ensureLibraryCollection(ports.libraryCollectionUnitOfWork, { principalId: context.principal.principalId, subjectId });
  }
  const page = await getOwnedCollectionsPage(ports, {
    actor: { subjectId },
    ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
  });
  const collections = page.items.map((item) => Object.freeze({
    ...(item.isLibrary ? { library: true } : {}),
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
  options: { readonly libraryCollectionUnitOfWork: LibraryCollectionUnitOfWork },
): Phase4bMcpOwnedCollectionCreateService {
  return Object.freeze({
    async execute(_input: Readonly<Record<string, unknown>>, context: Phase4bMcpLowRiskNodeCreateContext): Promise<never> {
      const binding = requireAuthenticatedWriteBinding(snapshotMcpAuthorizationBinding(context.binding));
      if (!context.scope.includes('collections:create')) {
        throw new Phase4bMcpLowRiskNodeCreateError('scope_invalid', 'Unknown tool.');
      }
      const subjectId = requireMcpAccountSubjectId({ accountSubjectId: context.accountSubjectId });
      const library = await ensureLibraryCollection(options.libraryCollectionUnitOfWork, {
        principalId: binding.principalId, subjectId,
      });
      throw new LibraryFolderRequiredError(library);
    },
  });
}
