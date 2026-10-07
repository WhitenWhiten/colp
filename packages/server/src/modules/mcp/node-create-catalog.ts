/**
 * Single source for `nodes.create` node-object catalog constraints.
 *
 * `write-tools.ts` publishes this schema on tools/list. The low-risk parser
 * imports the same frozen kind branches and required-key lists so a client
 * that satisfies the listed schema cannot fail later on missing `description`,
 * missing bookmark `url`, null bookmark `url`, or a folder `url`.
 */
import {
  BOOKMARK_URL_HTTP_NO_USERINFO_PATTERN,
  BOOKMARK_URL_MAX_LENGTH,
  BOOKMARK_URL_MIN_LENGTH,
} from '../collections/index.js';

export const PHASE4B_MCP_NODE_CREATE_FOLDER_KIND = 'folder' as const;
export const PHASE4B_MCP_NODE_CREATE_BOOKMARK_KIND = 'bookmark' as const;

export const PHASE4B_MCP_NODE_CREATE_KINDS = Object.freeze([
  PHASE4B_MCP_NODE_CREATE_FOLDER_KIND,
  PHASE4B_MCP_NODE_CREATE_BOOKMARK_KIND,
] as const);

export const PHASE4B_MCP_NODE_CREATE_VISIBILITIES = Object.freeze([
  'inherit',
  'protected',
  'private',
] as const);

export const PHASE4B_MCP_NODE_CREATE_DEFAULT_REASON = 'Save via MCP' as const;

export const PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS = Object.freeze([
  'kind',
  'title',
] as const);

export const PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS = Object.freeze([
  'kind',
  'title',
  'url',
] as const);

export const PHASE4B_MCP_NODE_CREATE_OPTIONAL_KEYS = Object.freeze([
  'description',
  'tags',
  'visibility',
] as const);

export const PHASE4B_MCP_NODE_CREATE_KNOWN_KEYS = frozenUniqueKeys(
  PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_OPTIONAL_KEYS,
);

const titleProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
} as const);

const descriptionProperty = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({ type: 'null' }),
    Object.freeze({ type: 'string', maxLength: 10_000 }),
  ]),
} as const);

const tagsProperty = Object.freeze({
  type: 'array',
  maxItems: 128,
  items: Object.freeze({ type: 'string', maxLength: 256 }),
} as const);

const visibilityProperty = Object.freeze({
  type: 'string',
  enum: PHASE4B_MCP_NODE_CREATE_VISIBILITIES,
} as const);

const bookmarkUrlProperty = Object.freeze({
  type: 'string',
  minLength: BOOKMARK_URL_MIN_LENGTH,
  maxLength: BOOKMARK_URL_MAX_LENGTH,
  pattern: BOOKMARK_URL_HTTP_NO_USERINFO_PATTERN,
} as const);

const folderNodeProperties = Object.freeze({
  kind: Object.freeze({ type: 'string', const: PHASE4B_MCP_NODE_CREATE_FOLDER_KIND }),
  title: titleProperty,
  description: descriptionProperty,
  tags: tagsProperty,
  visibility: visibilityProperty,
} as const);

const bookmarkNodeProperties = Object.freeze({
  kind: Object.freeze({ type: 'string', const: PHASE4B_MCP_NODE_CREATE_BOOKMARK_KIND }),
  title: titleProperty,
  url: bookmarkUrlProperty,
  description: descriptionProperty,
  tags: tagsProperty,
  visibility: visibilityProperty,
} as const);

export const PHASE4B_MCP_NODE_CREATE_FOLDER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: folderNodeProperties,
  required: PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  not: Object.freeze({
    required: Object.freeze(['url']),
  }),
} as const);

export const PHASE4B_MCP_NODE_CREATE_BOOKMARK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: bookmarkNodeProperties,
  required: PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
} as const);

export const PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA = Object.freeze({
  type: 'object',
  oneOf: Object.freeze([
    PHASE4B_MCP_NODE_CREATE_FOLDER_SCHEMA,
    PHASE4B_MCP_NODE_CREATE_BOOKMARK_SCHEMA,
  ]),
} as const);

const nodeUpdatePatchProperties = Object.freeze({
  title: titleProperty,
  url: bookmarkUrlProperty,
  description: descriptionProperty,
  tags: Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({ type: 'null' }),
      tagsProperty,
    ]),
  }),
} as const);

/** Closed RFC 7396 node merge patch advertised on `nodes.update`. */
export const PHASE4B_MCP_NODE_UPDATE_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: nodeUpdatePatchProperties,
} as const);

export function phase4bMcpNodeCreateRequiredKeysForKind(
  kind: typeof PHASE4B_MCP_NODE_CREATE_FOLDER_KIND | typeof PHASE4B_MCP_NODE_CREATE_BOOKMARK_KIND,
): readonly string[] {
  return kind === PHASE4B_MCP_NODE_CREATE_FOLDER_KIND
    ? PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS
    : PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS;
}

function frozenUniqueKeys(
  ...lists: readonly (readonly string[])[]
): readonly string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const list of lists) {
    for (const key of list) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return Object.freeze(keys);
}
