/**
 * P4B-R01 shared pure transport-entry contract (Known-Backend host side).
 *
 * This module freezes the MCP `2026-07-28` transport entry topology that the
 * Phase 4B host harness must prove, mirroring the COLP-MCP-03
 * `mcp-transport-entry-candidate` reference harness contract
 * (`colp/docs/MCP_SDK_POLICY.md` §7, `colp/docs/progress/MCP_TRANSPORT.md`):
 *
 * - a single POST-only MCP endpoint (`/collections/-/mcp`), no Session, no
 *   initialize, no GET/DELETE, no `Last-Event-ID` (migration decision §1/§3);
 * - the official `@modelcontextprotocol/server` `createMcpHandler` as the
 *   frozen SDK adapter with `{ legacy: 'reject' }`;
 * - hard ingress limits: raw body bytes, header count/name/value length,
 *   bounded FIFO dispatch (concurrency + queue);
 * - deterministic legacy rejection: legacy methods → method-not-found, legacy
 *   session headers → unsupported_protocol_version, non-POST verbs → 405;
 * - SDK N/N-1 lock: client/server/core `2.3.1`, legacy
 *   `@modelcontextprotocol/sdk` never present.
 *
 * It is deliberately pure (node:crypto + the COLP `/mcp` public surface only):
 * no Fastify, no SDK server/client package, no business table access. The
 * `@know-n/colp/mcp` import is the source-bound cross-check that
 * Known-Backend does not pick a second protocol version or SDK line.
 */
import { createHash } from 'node:crypto';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SDK_CORE_VERSION,
  MCP_SDK_PROTOCOL_VERSION,
} from '@know-n/colp/mcp';

/** Evidence/replay doc date label for this entry gate (P4B-R01). */
export const PHASE4B_MCP_END_DATE_LABEL = '2026-08-04' as const;

/** The only MCP protocol revision the host accepts (migration decision §1.3). */
export const PHASE4B_MCP_PROTOCOL_VERSION = '2026-07-28' as const;

/** The unique MCP endpoint; only POST is registered (plan §1.6). */
export const PHASE4B_MCP_ENDPOINT_PATH = '/collections/-/mcp' as const;

/** Frozen server info stamped into discover results (host-owned identity). */
export const PHASE4B_MCP_SERVER_INFO = Object.freeze({
  name: 'known-backend-mcp-entry-fixture',
  version: '0.0.0',
} as const);

/** Fixture resource served by the harness so discover reports real capabilities. */
export const PHASE4B_MCP_RESOURCE_URI = 'fixture://ping' as const;
export const PHASE4B_MCP_RESOURCE_BODY = 'pong' as const;

/** Frozen ingress hard limits (plan §2.7: raw body bytes, headers, connection budget). */
export const PHASE4B_MCP_HARD_LIMITS = Object.freeze({
  maxBodyBytes: 65_536,
  maxHeaderCount: 64,
  maxHeaderNameBytes: 128,
  maxHeaderValueBytes: 4_096,
  maxConcurrent: 1,
  maxQueue: 2,
} as const);

/** Frozen legacy rejection catalog (plan §5.2, migration decision §1.2-1.3). */
export const PHASE4B_MCP_LEGACY_REJECTION = Object.freeze({
  rejectedVerbs: Object.freeze(['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'] as const),
  sessionHeaders: Object.freeze(['mcp-session-id', 'last-event-id'] as const),
  rejectedMethods: Object.freeze([
    'initialize',
    'notifications/initialized',
    'ping',
    'logging/setLevel',
    'notifications/roots/list_changed',
    'resources/subscribe',
    'resources/unsubscribe',
  ] as const),
} as const);

/** MCP 2026-07-28 stable error codes used by the transport entry (plan §3.1.7). */
export const PHASE4B_MCP_LEGACY_ERROR_CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022 as const;
export const PHASE4B_MCP_LEGACY_ERROR_CODE_METHOD_NOT_FOUND = -32601 as const;

/** Frozen SDK N/N-1 lock, identical to the COLP-MCP-03 lock (MCP_SDK_POLICY §1/§5). */
export const PHASE4B_MCP_SDK_LOCK = Object.freeze({
  client: '2.3.1',
  server: '2.3.1',
  core: '2.3.1',
  legacySdkAbsent: '@modelcontextprotocol/sdk',
} as const);

export const PHASE4B_MCP_REPLAY_SCHEMA_VERSION = 'known.phase4b.mcp-entry-gate.replay.v1' as const;
export const PHASE4B_MCP_EVIDENCE_SCHEMA_VERSION = 'known.phase4b.mcp-entry-gate.probe.v1' as const;
export const PHASE4B_MCP_EVIDENCE_KIND = 'known.phase4b.mcp-entry-controlled-fixture-probe' as const;

// Source-bound cross-check: the host must not select a second protocol version
// or a second SDK line (plan §1.5, migration decision §8). Failing these
// assertions at load time is the fail-closed proof of "no second choice".
if (PHASE4B_MCP_PROTOCOL_VERSION !== MCP_PROTOCOL_VERSION) {
  throw new Error(`phase4b mcp entry protocol drift: host ${PHASE4B_MCP_PROTOCOL_VERSION} != COLP ${MCP_PROTOCOL_VERSION}`);
}
if (PHASE4B_MCP_PROTOCOL_VERSION !== MCP_SDK_PROTOCOL_VERSION) {
  throw new Error(`phase4b mcp entry SDK protocol drift: host ${PHASE4B_MCP_PROTOCOL_VERSION} != COLP ${MCP_SDK_PROTOCOL_VERSION}`);
}
if (PHASE4B_MCP_SDK_LOCK.core !== MCP_SDK_CORE_VERSION) {
  throw new Error(`phase4b mcp entry SDK core lock drift: host ${PHASE4B_MCP_SDK_LOCK.core} != COLP ${MCP_SDK_CORE_VERSION}`);
}

export interface Phase4bMcpEntryModernEnvelopeInput {
  readonly protocolVersion?: string;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

/**
 * Builds the per-request `_meta` envelope required by MCP 2026-07-28
 * (protocolVersion + clientCapabilities are required; clientInfo is SHOULD).
 * Mirrors COLP `tests/fixtures/mcp-2026-07-28/fixture-host/legacy-policy.ts`.
 */
export function buildPhase4bModernEnvelope(
  input: Phase4bMcpEntryModernEnvelopeInput = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    'io.modelcontextprotocol/protocolVersion': input.protocolVersion ?? PHASE4B_MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': input.clientInfo ?? {
      name: 'known-backend-mcp-entry-probe',
      version: '0.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': input.clientCapabilities ?? {},
  });
}

/**
 * Returns the first legacy session-era header present on a raw header list
 * (`rawHeaders` pairs: name0, value0, name1, value1, ...), if any. The
 * 2026-07-28 transport ignores these headers, so the host rejects them at the
 * ingress to keep the Modern-only contract end to end.
 */
export function findPhase4bLegacySessionHeader(rawHeaders: readonly string[]): string | undefined {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]?.toLowerCase() ?? '';
    if (PHASE4B_MCP_LEGACY_REJECTION.sessionHeaders.includes(name as never)) return name;
  }
  return undefined;
}

export interface Phase4bMcpEntryHardLimits {
  readonly maxBodyBytes: number;
  readonly maxHeaderCount: number;
  readonly maxHeaderNameBytes: number;
  readonly maxHeaderValueBytes: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

export interface Phase4bMcpEntryLegacyRejection {
  readonly rejectedVerbs: readonly string[];
  readonly sessionHeaders: readonly string[];
  readonly rejectedMethods: readonly string[];
}

export interface Phase4bMcpEntrySdkLockFacts {
  readonly client: string;
  readonly server: string;
  readonly core: string;
  readonly legacySdkAbsent: string;
}

export interface Phase4bMcpEntryFixtureFrozen {
  readonly endpointPath: string;
  readonly protocolVersion: string;
  readonly serverInfo: Readonly<{ readonly name: string; readonly version: string }>;
  readonly resourceUri: string;
  readonly resourceBody: string;
  readonly hardLimits: Phase4bMcpEntryHardLimits;
  readonly legacyRejection: Phase4bMcpEntryLegacyRejection;
}

export interface Phase4bMcpEntryReplayScenario {
  readonly id: string;
  readonly [field: string]: unknown;
}

export interface Phase4bMcpEntryReplayManifest {
  readonly schemaVersion: string;
  readonly frozen: Phase4bMcpEntryFixtureFrozen;
  readonly fixedInputs: Readonly<Record<string, unknown>>;
  readonly sdkLock: Phase4bMcpEntrySdkLockFacts;
  readonly scenarios: readonly Phase4bMcpEntryReplayScenario[];
  readonly negativeControls: readonly string[];
  readonly recordedOutcomes: { readonly digestAlgorithm: string; readonly digest: string };
}

export interface Phase4bMcpEntryReplayDigestInput {
  readonly schemaVersion: string;
  readonly frozen: Phase4bMcpEntryFixtureFrozen;
  readonly scenarios: readonly Phase4bMcpEntryReplayScenario[];
}

/**
 * Deterministic, order-independent JSON serialization (recursive key sort) so
 * the committed replay digest, the probe's recorded digest and the validator
 * all agree regardless of object construction order.
 */
export function canonicalMcpEntryJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalMcpEntryJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalMcpEntryJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha-256 over the canonical frozen replay input (digestAlgorithm: sha-256). */
export function computeMcpEntryReplayDigest(input: Phase4bMcpEntryReplayDigestInput): string {
  return createHash('sha256').update(canonicalMcpEntryJson(input), 'utf8').digest('hex');
}

/**
 * Single source of truth mapping each legacy negative-control scenario to the
 * exact wire input it must exercise. The probe drives its legacy scenarios
 * from this map so the legacy vocabulary never gets hand-written a second
 * time inside the host harness.
 */
export const PHASE4B_MCP_LEGACY_SCENARIO_INPUTS = Object.freeze({
  'legacy-session-header': 'mcp-session-id',
  'legacy-last-event-id-header': 'last-event-id',
  'legacy-method-initialize': 'initialize',
  'legacy-method-ping': 'ping',
  'legacy-method-logging-set-level': 'logging/setLevel',
  'legacy-method-resources-subscribe': 'resources/subscribe',
  'legacy-method-resources-unsubscribe': 'resources/unsubscribe',
} as const);

export type Phase4bMcpEntryLegacyScenarioId = keyof typeof PHASE4B_MCP_LEGACY_SCENARIO_INPUTS;

/** Returns the wire input for a legacy negative-control scenario id, if any. */
export function phase4bMcpEntryLegacyScenarioInput(id: string): string | undefined {
  return (PHASE4B_MCP_LEGACY_SCENARIO_INPUTS as Readonly<Record<string, string>>)[id];
}

/**
 * Frozen legacy `initialize` request body (no modern `_meta` envelope) used by
 * the legacy negative control. Built here so the wire body stays inside the
 * catalog module.
 */
export function buildPhase4bLegacyInitializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy-client', version: '1.0.0' },
    },
  });
}

/**
 * Frozen legacy `notifications/initialized` body used by the legacy negative
 * control (a notification has no id; the modern-only server drops it with 202).
 */
export function buildPhase4bLegacyNotificationInitializedBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
}