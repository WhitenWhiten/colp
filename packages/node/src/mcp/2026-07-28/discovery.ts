/**
 * MCP `2026-07-28` `server/discover` adapter.
 *
 * `server/discover` is the only discovery mechanism in the modern era
 * (migration decision §3 / §5): COLP advertises exactly `2026-07-28` in
 * `supportedVersions` and only the capabilities the host actually implements.
 * The result carries `resultType: 'complete'`, is validated against the
 * pinned `DiscoverResultSchema`, and is returned as a deeply frozen snapshot
 * so mutation after the adapter call cannot leak. Unknown capability keys are
 * stripped by the schema validation (the server "only declares implemented
 * items" — decision §6.10), and the adapter never auto-declares an extension.
 *
 * The result `_meta` carries `io.modelcontextprotocol/serverInfo` (spec
 * PR #3002: servers SHOULD include it on every response).
 */
import { snapshotMcpData } from '../safe-data.js';
import { MCP_PROTOCOL_VERSION } from '../protocol-version.js';
import type { Mcp20260728ClientInfo } from './request-context.js';
import {
  DiscoverRequestSchema,
  DiscoverResultSchema,
  ImplementationSchema,
  SERVER_INFO_META_KEY,
} from '../../shared/mcp-sdk-boundary.js';

/** Server implementation info stamped into discover result `_meta`. */
export type Mcp20260728ServerInfo = Mcp20260728ClientInfo;

/**
 * Real capabilities the host implements. Known `2026-07-28` capability groups
 * (`experimental`, `logging`, `completions`, `prompts`, `resources`, `tools`,
 * `extensions`) plus any host-specific open keys; only implemented items may
 * be declared (decision §6.10).
 */
export type Mcp20260728ServerCapabilities = Readonly<Record<string, unknown>>;

/** Frozen `server/discover` result for protocol version `2026-07-28`. */
export interface Mcp20260728DiscoverResult {
  readonly resultType: 'complete';
  readonly supportedVersions: readonly ['2026-07-28'];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly instructions?: string;
  readonly _meta?: Readonly<{ [SERVER_INFO_META_KEY]: Mcp20260728ServerInfo }>;
}

export interface Mcp20260728DiscoverInput {
  readonly serverInfo: Mcp20260728ServerInfo;
  readonly capabilities: Mcp20260728ServerCapabilities;
  readonly instructions?: string;
}

/**
 * Builds the frozen discover result. `supportedVersions` is fixed to
 * `['2026-07-28']`; capabilities and serverInfo are own-data snapshots, and
 * the assembled result must pass the pinned `DiscoverResultSchema` (SDK
 * validation; unknown capability keys are stripped). Throws `TypeError` on
 * malformed host input (host bug, fail closed).
 */
export function createMcp20260728DiscoverResult(
  input: Mcp20260728DiscoverInput,
): Mcp20260728DiscoverResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('MCP discover result input must be an own-data object.');
  }
  const serverInfo = readOwnValue(input, 'serverInfo');
  const capabilitiesRaw = readOwnValue(input, 'capabilities');
  const instructions = readOwnValue(input, 'instructions');
  if (typeof serverInfo !== 'object' || serverInfo === null) {
    throw new TypeError('MCP discover result requires a serverInfo object.');
  }
  const serverInfoParsed = ImplementationSchema.safeParse(serverInfo);
  if (!serverInfoParsed.success) {
    throw new TypeError('MCP discover result serverInfo is invalid.');
  }
  if (typeof capabilitiesRaw !== 'object' || capabilitiesRaw === null || Array.isArray(capabilitiesRaw)) {
    throw new TypeError('MCP discover result requires a capabilities object.');
  }
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new TypeError('MCP discover result instructions must be a string.');
  }

  const candidate: Mcp20260728DiscoverResult = {
    resultType: 'complete',
    supportedVersions: [MCP_PROTOCOL_VERSION],
    capabilities: capabilitiesRaw as Readonly<Record<string, unknown>>,
    ...(instructions !== undefined ? { instructions } : {}),
    _meta: {
      [SERVER_INFO_META_KEY]: serverInfoParsed.data as Mcp20260728ServerInfo,
    },
  };
  const parsed = DiscoverResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TypeError('MCP discover result failed SDK schema validation.');
  }
  const canonical = parsed.data as unknown as Mcp20260728DiscoverResult;
  const capabilities = snapshotMcpData(canonical.capabilities) as Readonly<Record<string, unknown>>;
  const meta = isPlainRecord(canonical._meta)
    ? Object.freeze({ [SERVER_INFO_META_KEY]: Object.freeze(snapshotImplementation(canonical._meta[SERVER_INFO_META_KEY])) })
    : undefined;
  return Object.freeze({
    resultType: 'complete' as const,
    supportedVersions: Object.freeze([...canonical.supportedVersions]) as readonly ['2026-07-28'],
    capabilities,
    ...(canonical.instructions !== undefined ? { instructions: canonical.instructions } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  }) as Mcp20260728DiscoverResult;
}

function snapshotImplementation(value: unknown): Mcp20260728ServerInfo {
  const snapshot = snapshotMcpData(value) as Readonly<Record<string, unknown>>;
  return Object.freeze(snapshot) as unknown as Mcp20260728ServerInfo;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Validates a `server/discover` request body against the pinned
 * `DiscoverRequestSchema` (SDK). Returns `{ ok: true }` or the first schema
 * issue message. Used by hosts before dispatching discovery; envelope/header
 * validation still happens through `createMcp20260728RequestContext`.
 */
export function validateMcp20260728DiscoverRequest(
  raw: unknown,
): { readonly ok: true } | { readonly ok: false; readonly issue: string } {
  const parsed = DiscoverRequestSchema.safeParse(raw);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  return { ok: false, issue: first === undefined ? 'invalid server/discover request' : first.message };
}

