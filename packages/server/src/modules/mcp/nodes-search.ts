/**
 * Optional mcp-read tool `nodes.search` (E3 / US-15).
 *
 * Recall is host-owned. Visibility and membership stay in `executeSearchQuery`:
 * the client's principal is the search principal, and annotation hits are
 * requested only when the client also has `annotations:read`.
 */
import {
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_MAX_TIMEOUT_MS,
  SearchQueryError,
  executeSearchQuery,
  type SearchCursorSignerPort,
  type SearchPrincipal,
  type SearchQueryPorts,
  type SearchResourceType,
  type SearchResult,
} from '../search/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolResult } from './application-results.js';
import {
  MCP_OAUTH_SCOPE_READ_OWN,
  MCP_OAUTH_SCOPE_READ_PUBLIC,
} from './scope-requirements.js';

export const NODES_SEARCH_TOOL_NAME = 'nodes.search' as const;
export const NODES_SEARCH_DESCRIPTION =
  'Search URLs, titles, and tags; searching annotations also requires annotations:read';
export const NODES_SEARCH_PROFILE_CLAIM = Object.freeze({
  profile: 'mcp-read' as const,
  optional: true as const,
  risk: 'none' as const,
  scope: 'nodes:read' as const,
  annotationScope: 'annotations:read' as const,
});

const MCP_JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;
const LINK_HEALTH_STATUSES = Object.freeze(['pending', 'healthy', 'redirect', 'broken'] as const);

export type NodesSearchLinkHealth = (typeof LINK_HEALTH_STATUSES)[number];

export const nodesSearchInputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    query: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 }),
    collectionId: Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 }),
    cursor: Object.freeze({ type: 'string', minLength: 1, maxLength: 2_048 }),
    limit: Object.freeze({ type: 'integer', minimum: 1, maximum: SEARCH_MAX_PAGE_SIZE }),
  }),
  required: Object.freeze(['query']),
});

export const nodesSearchOutputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    nodes: Object.freeze({
      type: 'array',
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({
          id: Object.freeze({ type: 'string' }),
          collectionId: Object.freeze({ type: 'string' }),
          folderPath: Object.freeze({ type: 'string' }),
          linkHealth: Object.freeze({
            anyOf: Object.freeze([
              Object.freeze({ type: 'string', enum: LINK_HEALTH_STATUSES }),
              Object.freeze({ type: 'null' }),
            ]),
          }),
        }),
        required: Object.freeze(['id', 'collectionId', 'folderPath', 'linkHealth']),
      }),
    }),
    cursor: Object.freeze({
      anyOf: Object.freeze([
        Object.freeze({ type: 'string' }),
        Object.freeze({ type: 'null' }),
      ]),
    }),
  }),
  required: Object.freeze(['nodes', 'cursor']),
});

export const nodesSearchDefinition = Object.freeze({
  name: NODES_SEARCH_TOOL_NAME,
  description: NODES_SEARCH_DESCRIPTION,
  inputSchema: nodesSearchInputSchema,
  outputSchema: nodesSearchOutputSchema,
});

export interface NodesSearchCard {
  readonly id: string;
  readonly collectionId: string;
  readonly folderPath: string;
  readonly linkHealth: NodesSearchLinkHealth | null;
}

export interface NodesSearchCardPort {
  load(nodes: readonly { readonly id: string; readonly collectionId: string }[]): Promise<readonly NodesSearchCard[]>;
}

export interface NodesSearchPorts {
  readonly search: Omit<SearchQueryPorts, 'candidates'>;
  readonly candidatesFor: (collectionId: string | undefined) => SearchQueryPorts['candidates'];
  readonly cards: NodesSearchCardPort;
}

export interface NodesSearchNode {
  readonly id: string;
  readonly collectionId: string;
  readonly folderPath: string;
  readonly linkHealth: NodesSearchLinkHealth | null;
}

export interface NodesSearchResult {
  readonly nodes: readonly NodesSearchNode[];
  readonly cursor: string | null;
}

export interface NodesSearchInput {
  readonly principal: SearchPrincipal;
  readonly scopes: readonly string[];
  readonly query: unknown;
  readonly collectionId?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
  readonly signal?: AbortSignal;
}

export async function executeNodesSearch(
  ports: NodesSearchPorts,
  input: NodesSearchInput,
): Promise<NodesSearchResult> {
  if (!Array.isArray(input.scopes) || !input.scopes.includes(NODES_SEARCH_PROFILE_CLAIM.scope)) {
    throw new TypeError('nodes.search requires the nodes:read scope.');
  }
  const query = readQuery(input.query);
  const collectionId = readOptionalToken(input.collectionId, 'collectionId');
  const cursor = readOptionalToken(input.cursor, 'cursor');
  const limit = readLimit(input.limit);
  const types: readonly SearchResourceType[] = input.scopes.includes(NODES_SEARCH_PROFILE_CLAIM.annotationScope)
    ? Object.freeze(['node', 'annotation'])
    : Object.freeze(['node']);
  const searched = await executeSearchQuery({
    ...ports.search,
    candidates: ports.candidatesFor(collectionId),
    cursors: bindCollectionCursor(ports.search.cursors, collectionId),
  }, {
    principal: input.principal,
    query,
    types,
    ...(cursor === undefined ? { pageSize: limit } : { cursor }),
    timeoutMs: SEARCH_MAX_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const ordered = dedupeNodes(searched.items, collectionId);
  const cards = await ports.cards.load(ordered);
  const byKey = new Map(cards.map((card) => [cardKey(card.collectionId, card.id), card]));
  return Object.freeze({
    nodes: Object.freeze(ordered.map((node) => {
      const card = byKey.get(cardKey(node.collectionId, node.id));
      return Object.freeze({
        id: node.id,
        collectionId: node.collectionId,
        folderPath: card?.folderPath ?? '/',
        linkHealth: card?.linkHealth ?? null,
      });
    })),
    cursor: searched.page.nextCursor,
  });
}

export async function callNodesSearchTool(
  ports: NodesSearchPorts,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  try {
    const result = await executeNodesSearch(ports, {
      principal: searchPrincipalFromMcpContext(context),
      scopes: context.scopes,
      query: args.query,
      collectionId: args.collectionId,
      cursor: args.cursor,
      limit: args.limit,
      signal: context.abortSignal,
    });
    return Object.freeze({
      kind: 'complete',
      content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(result) })]),
      structuredContent: result,
    });
  } catch (error) {
    if (error instanceof SearchQueryError || error instanceof TypeError) {
      return Object.freeze({
        kind: 'rejected',
        stableCode: error instanceof SearchQueryError ? error.code : 'invalid_params',
        safeMessage: error.message,
        retryable: error instanceof SearchQueryError && error.code === 'search_timeout',
      });
    }
    throw error;
  }
}

export function searchPrincipalFromMcpContext(context: McpApplicationContext): SearchPrincipal {
  if (context.principal.kind === 'anonymous') return Object.freeze({ kind: 'anonymous' });
  // `nodes:read` is an optional search profile claim, not a grant to the
  // account/member projection.  A public-only MCP token must search through
  // the same anonymous Publication visibility fence as the core Read Tools.
  if (
    context.scopes.includes(MCP_OAUTH_SCOPE_READ_PUBLIC)
    && !context.scopes.includes(MCP_OAUTH_SCOPE_READ_OWN)
  ) {
    return Object.freeze({ kind: 'anonymous' });
  }
  return Object.freeze({
    kind: 'account',
    accountId: context.principal.principalId,
    principalId: context.principal.principalId,
    subjectId: requireMcpAccountSubjectId(context.authorization),
    securityEpoch: context.principal.securityEpoch,
  });
}

function dedupeNodes(
  items: readonly SearchResult[],
  collectionId: string | undefined,
): readonly { readonly id: string; readonly collectionId: string }[] {
  const seen = new Set<string>();
  const ordered: { id: string; collectionId: string }[] = [];
  for (const item of items) {
    const node = nodeIdentity(item);
    if (node === undefined) continue;
    if (collectionId !== undefined && node.collectionId !== collectionId) continue;
    const key = cardKey(node.collectionId, node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(node);
  }
  return ordered;
}

function nodeIdentity(
  item: SearchResult,
): { readonly id: string; readonly collectionId: string } | undefined {
  if (item.resourceType === 'node') {
    return { id: item.resourceId, collectionId: item.collectionId };
  }
  if (item.resourceType === 'annotation' && item.subject.type === 'node') {
    return { id: item.subject.id, collectionId: item.collectionId };
  }
  return undefined;
}

function bindCollectionCursor(
  cursors: SearchCursorSignerPort,
  collectionId: string | undefined,
): SearchCursorSignerPort {
  return Object.freeze({
    currentKeyId: cursors.currentKeyId,
    digestScope(value: unknown, keyId?: string): string {
      if (!isNormalizedQueryScope(value)) {
        return keyId === undefined ? cursors.digestScope(value) : cursors.digestScope(value, keyId);
      }
      const bound = { normalizedQuery: value.normalizedQuery, nodesSearchCollectionId: collectionId ?? null };
      return keyId === undefined ? cursors.digestScope(bound) : cursors.digestScope(bound, keyId);
    },
    sign: (payload: Parameters<SearchCursorSignerPort['sign']>[0]) => cursors.sign(payload),
    verify: (
      token: Parameters<SearchCursorSignerPort['verify']>[0],
      now: Parameters<SearchCursorSignerPort['verify']>[1],
    ) => cursors.verify(token, now),
  });
}

function isNormalizedQueryScope(value: unknown): value is { readonly normalizedQuery: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as { readonly normalizedQuery?: unknown };
  return Object.keys(record).length === 1 && typeof record.normalizedQuery === 'string';
}

function readQuery(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('nodes.search query is required');
  }
  return value;
}

function readOptionalToken(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') {
    throw new TypeError(`nodes.search ${label} is invalid`);
  }
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined) return SEARCH_DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SEARCH_MAX_PAGE_SIZE) {
    throw new TypeError('nodes.search limit must be an integer from 1 to 100');
  }
  return value;
}

function cardKey(collectionId: string, id: string): string {
  return `${collectionId}\0${id}`;
}
