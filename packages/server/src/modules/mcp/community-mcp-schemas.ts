/**
 * Frozen JSON-schema fragments for the 13 community MCP compatibility tools
 * (`community-social-api-contract.yaml` `x-mcp-tools`, lines 2390–2856).
 * Every advertised inputSchema is the exact closed arguments object the
 * contract pins; every outputSchema is the contract union of the
 * operation's success body and the baseline `ProductErrorEnvelope` (the
 * contract `Error` alias). Baseline `$ref`s (OpaqueId, CommandId, EntityTag,
 * ProductError*, RequestId) are inlined verbatim so compat `tools/list`
 * never emits a reference a client cannot resolve.
 */
import { COMMUNITY_STATIC_GENERATION } from '../community/index.js';
import { closedObject, toolArguments } from './community-mcp-closed-object.js';

const OPAQUE_ID = Object.freeze({
  type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$',
});
const COMMAND_ID = Object.freeze({
  type: 'string', format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const CURSOR = Object.freeze({
  type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$',
});
const ETAG = Object.freeze({
  type: 'string', minLength: 3, maxLength: 260, pattern: '^"[^"\\r\\n]+"$',
});
const REVISION = Object.freeze({
  type: 'string', minLength: 1, maxLength: 19, pattern: '^[1-9][0-9]{0,18}$', example: '1',
});
const TIMESTAMP = Object.freeze({
  type: 'string', minLength: 24, maxLength: 24, format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  example: '2026-09-15T00:00:00.000Z',
});
const NULL = Object.freeze({ type: 'null' });
const NULLABLE_ID = Object.freeze({ oneOf: Object.freeze([OPAQUE_ID, NULL]) });
const NULLABLE_CURSOR = Object.freeze({ oneOf: Object.freeze([CURSOR, NULL]) });
const PAGE_LIMIT_20 = Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
const ID_LIST = Object.freeze({
  type: 'array', items: OPAQUE_ID, minItems: 1, maxItems: 100, uniqueItems: true,
});
const COUNT = Object.freeze({ type: 'integer', minimum: 0, maximum: 2_147_483_647 });
const REASON = Object.freeze({ type: 'string', minLength: 1, maxLength: 1_000 });
const NULLABLE_REASON = Object.freeze({ oneOf: Object.freeze([REASON, NULL]) });
const TITLE = Object.freeze({ type: 'string', minLength: 1, maxLength: 512 });
const HREF = Object.freeze({
  type: 'string', minLength: 1, maxLength: 8_192, format: 'uri-reference',
});
const COMMENT_BODY = Object.freeze({ type: 'string', minLength: 1, maxLength: 4_000 });
const VOTE_VALUE = Object.freeze({ type: 'integer', enum: Object.freeze([-1, 0, 1]) });
const STATIC_GENERATION = Object.freeze({ const: COMMUNITY_STATIC_GENERATION });

/** Contract `Target`: the closed five-field oneOf used in bodies and views. */
export const COMMUNITY_MCP_TARGET_SCHEMA = Object.freeze({
  oneOf: Object.freeze([
    closedObject(
      {
        kind: Object.freeze({ const: 'collection' }),
        id: OPAQUE_ID,
        collectionId: NULL,
        seriesId: NULL,
        generation: STATIC_GENERATION,
      },
      ['kind', 'id', 'collectionId', 'seriesId', 'generation'],
    ),
    closedObject(
      {
        kind: Object.freeze({ const: 'bookmark' }),
        id: OPAQUE_ID,
        collectionId: OPAQUE_ID,
        seriesId: NULL,
        generation: OPAQUE_ID,
      },
      ['kind', 'id', 'collectionId', 'seriesId', 'generation'],
    ),
    closedObject(
      {
        kind: Object.freeze({ const: 'digest_series' }),
        id: OPAQUE_ID,
        collectionId: NULL,
        seriesId: NULL,
        generation: STATIC_GENERATION,
      },
      ['kind', 'id', 'collectionId', 'seriesId', 'generation'],
    ),
    closedObject(
      {
        kind: Object.freeze({ const: 'digest_edition' }),
        id: OPAQUE_ID,
        collectionId: NULL,
        seriesId: OPAQUE_ID,
        generation: STATIC_GENERATION,
      },
      ['kind', 'id', 'collectionId', 'seriesId', 'generation'],
    ),
  ]),
});

const COMMENTS_QUERY_VARIANTS = Object.freeze([
  closedObject(
    {
      kind: Object.freeze({ const: 'collection' }),
      id: OPAQUE_ID,
      generation: STATIC_GENERATION,
      limit: PAGE_LIMIT_20,
      cursor: CURSOR,
    },
    ['kind', 'id', 'generation'],
  ),
  closedObject(
    {
      kind: Object.freeze({ const: 'bookmark' }),
      id: OPAQUE_ID,
      generation: OPAQUE_ID,
      limit: PAGE_LIMIT_20,
      cursor: CURSOR,
      collectionId: OPAQUE_ID,
    },
    ['kind', 'id', 'collectionId', 'generation'],
  ),
  closedObject(
    {
      kind: Object.freeze({ const: 'digest_series' }),
      id: OPAQUE_ID,
      generation: STATIC_GENERATION,
      limit: PAGE_LIMIT_20,
      cursor: CURSOR,
    },
    ['kind', 'id', 'generation'],
  ),
  closedObject(
    {
      kind: Object.freeze({ const: 'digest_edition' }),
      id: OPAQUE_ID,
      generation: STATIC_GENERATION,
      limit: PAGE_LIMIT_20,
      cursor: CURSOR,
      seriesId: OPAQUE_ID,
    },
    ['kind', 'id', 'seriesId', 'generation'],
  ),
]);

const COMMENT_PATH = closedObject({ commentId: OPAQUE_ID }, ['commentId']);
const CURATED_BODY = closedObject({ hidden: Object.freeze({ type: 'boolean' }), reason: REASON },
  ['hidden', 'reason']);

/** `known.community.target` arguments: `{ query: <target oneOf> }`. */
export const COMMUNITY_MCP_TARGET_INPUT = toolArguments(
  {
    query: Object.freeze({
      oneOf: Object.freeze([
        closedObject(
          { kind: Object.freeze({ const: 'collection' }), id: OPAQUE_ID },
          ['kind', 'id'],
        ),
        closedObject(
          {
            kind: Object.freeze({ const: 'bookmark' }),
            id: OPAQUE_ID,
            collectionId: OPAQUE_ID,
          },
          ['kind', 'id', 'collectionId'],
        ),
        closedObject(
          { kind: Object.freeze({ const: 'digest_series' }), id: OPAQUE_ID },
          ['kind', 'id'],
        ),
        closedObject(
          {
            kind: Object.freeze({ const: 'digest_edition' }),
            id: OPAQUE_ID,
            seriesId: OPAQUE_ID,
          },
          ['kind', 'id', 'seriesId'],
        ),
      ]),
    }),
  },
  ['query'],
);

/** `known.community.vote` arguments: `{ body: VoteRequest, commandId }`. */
export const COMMUNITY_MCP_VOTE_INPUT = toolArguments(
  {
    body: closedObject(
      { target: COMMUNITY_MCP_TARGET_SCHEMA, value: VOTE_VALUE },
      ['target', 'value'],
    ),
    commandId: COMMAND_ID,
  },
  ['body', 'commandId'],
);

/** `known.community.ranking` arguments: `{ query? }`, collectionId implies kind=bookmark. */
export const COMMUNITY_MCP_RANKING_INPUT = toolArguments(
  {
    query: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        kind: Object.freeze({
          type: 'string',
          enum: Object.freeze(['collection', 'bookmark', 'digest_series', 'digest_edition']),
        }),
        collectionId: OPAQUE_ID,
        q: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
        tag: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }),
        language: Object.freeze({ type: 'string', minLength: 1, maxLength: 35 }),
        limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 24 }),
        cursor: CURSOR,
      }),
      required: Object.freeze([]),
      dependentSchemas: Object.freeze({
        collectionId: Object.freeze({
          properties: Object.freeze({ kind: Object.freeze({ const: 'bookmark' }) }),
          required: Object.freeze(['kind']),
        }),
      }),
    }),
  },
  [],
);

/** `known.community.comments` arguments: `{ query: <paged target oneOf> }`. */
export const COMMUNITY_MCP_COMMENTS_INPUT = toolArguments(
  { query: Object.freeze({ oneOf: COMMENTS_QUERY_VARIANTS }) },
  ['query'],
);

/** `known.community.comment.create` arguments: `{ body: CreateComment, commandId }`. */
export const COMMUNITY_MCP_COMMENT_CREATE_INPUT = toolArguments(
  {
    body: closedObject(
      { target: COMMUNITY_MCP_TARGET_SCHEMA, body: COMMENT_BODY, replyToId: NULLABLE_ID },
      ['target', 'body', 'replyToId'],
    ),
    commandId: COMMAND_ID,
  },
  ['body', 'commandId'],
);

/** `known.community.comment.get` arguments: `{ path: { commentId } }`. */
export const COMMUNITY_MCP_COMMENT_GET_INPUT = toolArguments({ path: COMMENT_PATH }, ['path']);

/** `known.community.comment.edit` arguments. */
export const COMMUNITY_MCP_COMMENT_EDIT_INPUT = toolArguments(
  {
    path: COMMENT_PATH,
    body: closedObject({ body: COMMENT_BODY }, ['body']),
    commandId: COMMAND_ID,
    ifMatch: ETAG,
  },
  ['path', 'body', 'commandId', 'ifMatch'],
);

/** `known.community.comment.delete` arguments. */
export const COMMUNITY_MCP_COMMENT_DELETE_INPUT = toolArguments(
  { path: COMMENT_PATH, commandId: COMMAND_ID, ifMatch: ETAG },
  ['path', 'commandId', 'ifMatch'],
);

/** `known.community.comment.replies` arguments: `{ path, query? }`. */
export const COMMUNITY_MCP_COMMENT_REPLIES_INPUT = toolArguments(
  {
    path: COMMENT_PATH,
    query: closedObject({ limit: PAGE_LIMIT_20, cursor: CURSOR }, []),
  },
  ['path'],
);

/** `known.community.comment.curate` arguments. */
export const COMMUNITY_MCP_COMMENT_CURATE_INPUT = toolArguments(
  { path: COMMENT_PATH, body: CURATED_BODY, commandId: COMMAND_ID, ifMatch: ETAG },
  ['path', 'body', 'commandId', 'ifMatch'],
);

/** `known.community.comments.configure` arguments: `{ body: PutCommentSettings, commandId, ifMatch }`. */
export const COMMUNITY_MCP_COMMENTS_CONFIGURE_INPUT = toolArguments(
  {
    body: closedObject(
      { target: COMMUNITY_MCP_TARGET_SCHEMA, locked: Object.freeze({ type: 'boolean' }), reason: REASON },
      ['target', 'locked', 'reason'],
    ),
    commandId: COMMAND_ID,
    ifMatch: ETAG,
  },
  ['body', 'commandId', 'ifMatch'],
);

/** `known.community.notifications` arguments: `{ query? }`. */
export const COMMUNITY_MCP_NOTIFICATIONS_INPUT = toolArguments(
  {
    query: closedObject(
      {
        read: Object.freeze({ type: 'string', enum: Object.freeze(['all', 'unread']), default: 'all' }),
        limit: PAGE_LIMIT_20,
        cursor: CURSOR,
      },
      [],
    ),
  },
  [],
);

/** `known.community.notifications.read` arguments: `{ body: { ids }, commandId }`. */
export const COMMUNITY_MCP_NOTIFICATIONS_READ_INPUT = toolArguments(
  {
    body: closedObject({ ids: ID_LIST }, ['ids']),
    commandId: COMMAND_ID,
  },
  ['body', 'commandId'],
);

// ---------------------------------------------------------------------------
// Success bodies (the "exact HTTP JSON schema" of each operation).
// ---------------------------------------------------------------------------

const PUBLIC_ACTOR = closedObject(
  {
    id: OPAQUE_ID,
    handle: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'string', minLength: 1, maxLength: 63 }),
        NULL,
      ]),
    }),
    displayName: Object.freeze({ type: 'string', minLength: 1, maxLength: 200 }),
    avatarUrl: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'string', minLength: 1, maxLength: 8_192, format: 'uri-reference' }),
        NULL,
      ]),
    }),
  },
  ['id', 'handle', 'displayName', 'avatarUrl'],
);

const VOTE_STATE = closedObject(
  {
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    up: COUNT,
    down: COUNT,
    myVote: Object.freeze({ oneOf: Object.freeze([VOTE_VALUE, NULL]) }),
  },
  ['target', 'up', 'down', 'myVote'],
);

/** `TargetView.commentDeniedReason`: 'anonymous' | 'locked' | null (always emitted). */
const COMMENT_DENIED_REASON = Object.freeze({
  oneOf: Object.freeze([
    Object.freeze({ type: 'string', enum: Object.freeze(['anonymous', 'locked']) }),
    NULL,
  ]),
});

/** Contract `TargetView` success body. */
export const COMMUNITY_MCP_TARGET_VIEW_SCHEMA = closedObject(
  {
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    title: TITLE,
    href: HREF,
    canVote: Object.freeze({ type: 'boolean' }),
    canComment: Object.freeze({ type: 'boolean' }),
    commentDeniedReason: COMMENT_DENIED_REASON,
    canCurateComments: Object.freeze({ type: 'boolean' }),
    votes: VOTE_STATE,
  },
  ['target', 'title', 'href', 'canVote', 'canComment', 'canCurateComments', 'votes'],
);

/** Contract `VoteState` success body. */
export const COMMUNITY_MCP_VOTE_STATE_SCHEMA = VOTE_STATE;

const COMMENT = closedObject(
  {
    id: OPAQUE_ID,
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    rootId: OPAQUE_ID,
    replyToId: NULLABLE_ID,
    depth: Object.freeze({ type: 'integer', minimum: 0, maximum: 2 }),
    author: PUBLIC_ACTOR,
    body: Object.freeze({ oneOf: Object.freeze([COMMENT_BODY, NULL]) }),
    state: Object.freeze({ type: 'string', enum: Object.freeze(['visible', 'deleted', 'hidden']) }),
    revision: REVISION,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    replyCount: COUNT,
    canEdit: Object.freeze({ type: 'boolean' }),
    canDelete: Object.freeze({ type: 'boolean' }),
    canCurate: Object.freeze({ type: 'boolean' }),
  },
  [
    'id', 'target', 'rootId', 'replyToId', 'depth', 'author', 'body', 'state',
    'revision', 'createdAt', 'updatedAt', 'replyCount', 'canEdit', 'canDelete', 'canCurate',
  ],
);

/** Contract `Comment` success body. */
export const COMMUNITY_MCP_COMMENT_SCHEMA = COMMENT;

/** Contract comments/replies page `{ items, nextCursor }`. */
export const COMMUNITY_MCP_COMMENT_PAGE_SCHEMA = closedObject(
  {
    items: Object.freeze({ type: 'array', items: COMMENT, minItems: 0, maxItems: 100 }),
    nextCursor: NULLABLE_CURSOR,
  },
  ['items', 'nextCursor'],
);

const RANKING_ITEM = closedObject(
  {
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    title: TITLE,
    href: HREF,
    up: COUNT,
    down: COUNT,
    hot: Object.freeze({ type: 'number' }),
    firstVoteAt: Object.freeze({
      oneOf: Object.freeze([TIMESTAMP, NULL]),
      description: 'Time of the first accepted vote; null for a target with no accepted vote (no creation-time fallback).',
    }),
  },
  ['target', 'title', 'href', 'up', 'down', 'hot', 'firstVoteAt'],
);

/** Contract `RankingPage` success body. */
export const COMMUNITY_MCP_RANKING_PAGE_SCHEMA = closedObject(
  {
    items: Object.freeze({ type: 'array', items: RANKING_ITEM, minItems: 0, maxItems: 100 }),
    nextCursor: NULLABLE_CURSOR,
    asOf: TIMESTAMP,
    scoreVersion: Object.freeze({ const: 'hot-v1' }),
  },
  ['items', 'nextCursor', 'asOf', 'scoreVersion'],
);

/** Contract `Curation` success body. */
export const COMMUNITY_MCP_CURATION_SCHEMA = closedObject(
  {
    commentId: OPAQUE_ID,
    hidden: Object.freeze({ type: 'boolean' }),
    reason: NULLABLE_REASON,
    revision: REVISION,
    updatedAt: TIMESTAMP,
  },
  ['commentId', 'hidden', 'reason', 'revision', 'updatedAt'],
);

/** Contract `CommentSettings` success body. */
export const COMMUNITY_MCP_COMMENT_SETTINGS_SCHEMA = closedObject(
  {
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    locked: Object.freeze({ type: 'boolean' }),
    reason: NULLABLE_REASON,
    revision: REVISION,
    updatedAt: TIMESTAMP,
  },
  ['target', 'locked', 'reason', 'revision', 'updatedAt'],
);

const COMMUNITY_NOTIFICATION = closedObject(
  {
    id: OPAQUE_ID,
    kind: Object.freeze({ const: 'comment_reply' }),
    commentId: OPAQUE_ID,
    target: COMMUNITY_MCP_TARGET_SCHEMA,
    actor: PUBLIC_ACTOR,
    preview: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'string', minLength: 0, maxLength: 200 }),
        NULL,
      ]),
      description: 'Excerpt of the current comment body resolved at read time; null is the sole redacted representation when the source comment is deleted or hidden.',
    }),
    href: HREF,
    read: Object.freeze({ type: 'boolean' }),
    createdAt: TIMESTAMP,
  },
  ['id', 'kind', 'commentId', 'target', 'actor', 'preview', 'href', 'read', 'createdAt'],
);

/** Contract `CommunityInbox` success body. */
export const COMMUNITY_MCP_INBOX_SCHEMA = closedObject(
  {
    items: Object.freeze({
      type: 'array', items: COMMUNITY_NOTIFICATION, minItems: 0, maxItems: 100,
    }),
    nextCursor: NULLABLE_CURSOR,
    unreadCount: COUNT,
  },
  ['items', 'nextCursor', 'unreadCount'],
);

/** Contract notifications.read success body `{ changedIds, unreadCount }`. */
export const COMMUNITY_MCP_NOTIFICATION_READ_SCHEMA = closedObject(
  {
    changedIds: Object.freeze({
      type: 'array', items: OPAQUE_ID, minItems: 0, maxItems: 100, uniqueItems: true,
    }),
    unreadCount: COUNT,
  },
  ['changedIds', 'unreadCount'],
);

// ---------------------------------------------------------------------------
// Error half of every tool outputSchema: baseline ProductErrorEnvelope.
// ---------------------------------------------------------------------------

const FIELD_ERROR = closedObject(
  {
    path: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
    code: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }),
    message: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
  },
  ['path', 'code', 'message'],
);

/**
 * Baseline `ProductErrorCode` — the published enum (drifted codes stay out
 * per ADR-0015 and the baseline description) inlined so the advertised
 * schema is standalone.
 */
const PRODUCT_ERROR_CODE = Object.freeze({
  type: 'string',
  enum: Object.freeze([
    'invalid_request', 'invalid_json', 'invalid_query', 'invalid_cursor',
    'authentication_required', 'csrf_failed', 'insufficient_permission',
    'resource_not_found', 'method_not_allowed', 'command_id_reused',
    'command_in_progress', 'publication_slug_conflict', 'position_context_stale',
    'folder_not_empty', 'root_immutable', 'revision_conflict', 'snapshot_expired',
    'command_result_expired', 'precondition_failed', 'payload_too_large',
    'unsupported_media_type', 'invalid_document', 'precondition_required',
    'rate_limited', 'internal_error', 'feature_temporarily_unavailable',
  ]),
});

/** Baseline `ProductErrorEnvelope` — the contract `Error` alias. */
export const COMMUNITY_MCP_ERROR_ENVELOPE_SCHEMA = closedObject(
  {
    error: closedObject(
      {
        code: PRODUCT_ERROR_CODE,
        message: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }),
        requestId: Object.freeze({
          type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$',
        }),
        recovery: Object.freeze({
          type: 'string',
          enum: Object.freeze([
            'same_request', 'refresh_and_retry', 'restart_from_first_page',
            'user_action', 'none',
          ]),
        }),
        sameRequestRetrySafe: Object.freeze({ type: 'boolean' }),
        precondition: Object.freeze({
          type: Object.freeze(['string', 'null']),
          enum: Object.freeze(['resource', 'content', null]),
        }),
        currentEtag: Object.freeze({ oneOf: Object.freeze([ETAG, NULL]) }),
        retryAfterSeconds: Object.freeze({
          type: Object.freeze(['integer', 'null']), minimum: 0,
        }),
        fieldErrors: Object.freeze({ type: 'array', maxItems: 128, items: FIELD_ERROR }),
      },
      [
        'code', 'message', 'requestId', 'recovery', 'sameRequestRetrySafe',
        'precondition', 'currentEtag', 'retryAfterSeconds', 'fieldErrors',
      ],
    ),
  },
  ['error'],
);

/**
 * Contract tool outputSchema: the closed union of the operation's success
 * body and `ProductErrorEnvelope`. The object root keeps the advertised
 * schema deterministic on every era's tools/list serializer.
 */
export function communityToolOutputSchema(
  success: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: 'object',
    oneOf: Object.freeze([success, COMMUNITY_MCP_ERROR_ENVELOPE_SCHEMA]),
  });
}
