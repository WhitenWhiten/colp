import type { NodeCreate } from '@know-n/colp/types';
import { isAcceptedBookmarkUrl } from '../collections/index.js';
import { PHASE4B_MCP_NODE_CREATE_KNOWN_KEYS } from './node-create-catalog.js';
import { Phase4bMcpLowRiskNodeCreateError, nodeCreateHint, type McpNodeCreatePayload } from './node-create-contract.js';

/** Decode an already-owned JSON object into the common direct/plan command payload. */
export function parseMcpNodeCreatePayload(raw: Readonly<{ kind?: unknown; title?: unknown; description?: unknown; tags?: unknown; visibility?: unknown; url?: unknown }>): McpNodeCreatePayload {
  if (Object.keys(raw).some((key) => !(PHASE4B_MCP_NODE_CREATE_KNOWN_KEYS as readonly string[]).includes(key))) {
    throw new Phase4bMcpLowRiskNodeCreateError('open_payload_rejected', 'Node payload contains unknown fields.');
  }
  const invalid = (field: string, message: string): never => {
    throw new Phase4bMcpLowRiskNodeCreateError('invalid_catalog_input', message, nodeCreateHint(`node.${field}`));
  };
  const { kind, title } = raw;
  if (kind !== 'folder' && kind !== 'bookmark') return invalid('kind', 'Node create supports folder and bookmark only.');
  if (typeof title !== 'string' || title.length === 0) return invalid('title', 'Node title must be a non-empty string.');
  const description = raw.description ?? null;
  if (typeof description !== 'string' && description !== null) return invalid('description', 'Node description must be a string or null.');
  const tags = Object.hasOwn(raw, 'tags') ? raw.tags : [];
  if (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== 'string')) return invalid('tags', 'Node tags must be an array of strings.');
  const visibility = raw.visibility;
  if (visibility !== undefined && visibility !== 'inherit' && visibility !== 'protected' && visibility !== 'private') {
    return invalid('visibility', 'Node visibility must be inherit, protected, or private.');
  }
  const common: Omit<McpNodeCreatePayload, 'kind' | 'url'> = { title, description, tags: Object.freeze([...tags] as string[]), ...(visibility === undefined ? {} : { visibility }) };
  if (kind === 'folder') {
    if (Object.hasOwn(raw, 'url')) return invalid('url', 'Folder node cannot include a URL.');
    return Object.freeze({ ...common, kind });
  }
  if (typeof raw.url !== 'string' || !isAcceptedBookmarkUrl(raw.url)) return invalid('url', 'Bookmark URL must satisfy the canonical HTTP(S) URL contract.');
  return Object.freeze({ ...common, kind, url: raw.url });
}

/**
 * Single authority for the approved-Plan admission rule.
 *
 * Pre-unification the planner required `node.visibility` through
 * `readOwnRequiredString` and validated the enum. The direct `nodes.create`
 * tool kept visibility optional and resolved it from the collection. The
 * unified parser preserves the direct contract, so Plan admission restores the
 * original strictness here, next to the enum check it depends on.
 */
export function requireMcpNodeCreatePlanVisibility(
  payload: McpNodeCreatePayload,
): McpNodeCreatePayload & { readonly visibility: 'inherit' | 'protected' | 'private' } {
  if (payload.visibility === undefined) {
    throw new Phase4bMcpLowRiskNodeCreateError(
      'invalid_catalog_input',
      'nodes.create node payload requires visibility.',
      nodeCreateHint('node.visibility'),
    );
  }
  return payload as McpNodeCreatePayload & {
    readonly visibility: 'inherit' | 'protected' | 'private';
  };
}

/** Wire projection is the only place where JSON null becomes an absent description. */
export function canonicalMcpNodeCreatePayload(node: McpNodeCreatePayload): NodeCreate {
  const common = {
    title: node.title, tags: node.tags,
    ...(node.description === null ? {} : { description: node.description }),
    ...(node.visibility === undefined ? {} : { visibility: node.visibility }),
  };
  return node.kind === 'folder'
    ? Object.freeze({ ...common, kind: 'folder' })
    : Object.freeze({ ...common, kind: 'bookmark', url: node.url });
}
