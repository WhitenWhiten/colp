/**
 * Frozen host-compat MCP protocol constants for the Known-Backend
 * compatibility surface (T-00 / T-02). This is not a COLP Profile contract: the
 * strict endpoint remains `2026-07-28` only. Compat serving must pass
 * `MCP_COMPAT_PROTOCOL_VERSIONS` into the official SDK explicitly and must
 * never rely on the SDK default full version set.
 */
export const MCP_COMPAT_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25'] as const);

/** Negotiated/operational revision; the only value the host may emit. */
export const MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION = MCP_COMPAT_PROTOCOL_VERSIONS[0];

/** Frozen host-compat path; never an environment choice. */
export const MCP_COMPAT_ENDPOINT_PATH = '/collections/-/mcp-compat' as const;

export const MCP_COMPAT_READINESS_PATH = '/ready/features/mcp-compat' as const;

/** Named clients enter this list only after that exact pinned binary passed T-09. */
export const MCP_COMPAT_RECOMMENDED_CLIENTS: readonly string[] = Object.freeze([]);

/** Non-secret AuthInfo.token sentinel after upstream bearer verification. */
export const MCP_COMPAT_AUTH_TOKEN_SENTINEL = 'verified-upstream';

/** Fixed GET/DELETE body for the Claude-compatible 405 (no JSON-RPC). */
export const MCP_COMPAT_METHOD_NOT_ALLOWED_BODY = 'Method not allowed.';

/** Classifier-only onerror message; never copies SDK/error text or tokens. */
export const MCP_COMPAT_ONERROR_CLASSIFIER = 'mcp_compat_serving_failure';

/**
 * Frozen initialize `instructions` for the compatibility surface (T-06 / T-10).
 * The first 512 characters are self-contained: create a private library, save
 * links with nodes.create (apply by default), and never use changes.plan to
 * save a bookmark. Contains no user/tenant data, dynamic URLs, tokens, or
 * ops internals.
 */
export const MCP_COMPAT_INITIALIZE_INSTRUCTIONS = [
  'Create: collections.create(title,idempotencyKey). New UUID v4 per intent; reuse on retry.',
  'Save: nodes.create(collectionId,node.kind/title; bookmarks need node.url).',
  'Do not call changes.plan to save links.',
  'Parent defaults to root. dryRun:true or confirmApply:false previews; omit both to apply.',
  'changes.plan dryRun:true stores a pending plan; open approvalUri then changes.commit.',
  'Publish with collections.get revision.',
  'No elicitation, sampling, requestState or inputResponses.',
].join(' ');

/** JSON-RPC UnsupportedProtocolVersion; 07-28 envelopes on compat use this. */
export const MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE = -32_022 as const;

export const MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS = 400 as const;

/** Frozen JSON-RPC message for MCP-Protocol-Version admission rejects. */
export const MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE = 'Unsupported protocol version.' as const;

export type McpCompatReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export interface McpCompatRejectCounts {
  readonly total: number;
  readonly admission: number;
  readonly rate_limited: number;
  readonly auth: number;
  readonly unsupported: number;
}

export interface McpCompatReadinessDocument {
  readonly capability: 'mcp-compat';
  readonly enabled: true;
  readonly status: McpCompatReadinessStatus;
  readonly reasons: readonly string[];
  readonly supportedProtocolVersions: typeof MCP_COMPAT_PROTOCOL_VERSIONS;
  readonly admitting: boolean;
  readonly counts: {
    readonly activeRequests: number;
  };
  readonly rejectCounts: McpCompatRejectCounts;
}

export interface McpCompatReadinessLiveFields {
  readonly status?: McpCompatReadinessStatus;
  readonly reasons?: readonly string[];
  readonly admitting?: boolean;
  readonly counts?: { readonly activeRequests: number };
  readonly rejectCounts?: Partial<McpCompatRejectCounts>;
}

/** Idle identity-free document; T-07 passes live counters from operations. */
export function createMcpCompatReadinessDocument(
  live: McpCompatReadinessLiveFields = {},
): McpCompatReadinessDocument {
  return deepFreeze({
    capability: 'mcp-compat' as const,
    enabled: true as const,
    status: live.status ?? 'ready',
    reasons: Object.freeze([...(live.reasons ?? [])]),
    supportedProtocolVersions: MCP_COMPAT_PROTOCOL_VERSIONS,
    admitting: live.admitting ?? true,
    counts: Object.freeze({ activeRequests: live.counts?.activeRequests ?? 0 }),
    rejectCounts: Object.freeze({
      total: live.rejectCounts?.total ?? 0,
      admission: live.rejectCounts?.admission ?? 0,
      rate_limited: live.rejectCounts?.rate_limited ?? 0,
      auth: live.rejectCounts?.auth ?? 0,
      unsupported: live.rejectCounts?.unsupported ?? 0,
    }),
  });
}

export function redactMcpCompatOnerror(_error: unknown): Error {
  return new Error(MCP_COMPAT_ONERROR_CLASSIFIER);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
