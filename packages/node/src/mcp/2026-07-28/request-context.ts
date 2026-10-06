/**
 * per-request MCP `2026-07-28` request context adapter.
 *
 * This module maps wire facts (raw HTTP headers + the parsed JSON body
 * `_meta` envelope) into exactly one trusted, token-free
 * {@link Mcp20260728RequestContext} that shared/application ports consume.
 * It is the "trusted adapter call" unit: a host transport feeds one Modern
 * request through `createMcp20260728RequestContext` and gets one frozen
 * context (or a stable wire error) — no protocol Session, no retained state,
 * no raw token, no SDK request/transport object crossing a shared port.
 *
 * Sources (see docs/development/mcp-2026-07-28/migration-decision.md and
 * docs/development/mcp-2026-07-28/colp-sdk-development-plan.md):
 * - §6.1 (amended 2026-08-27): a missing
 *   `_meta` envelope or missing `protocolVersion` field -> -32602 (Invalid
 *   Params, upstream `_meta` contract); an unsupported version *value* ->
 *   -32022 (UnsupportedProtocolVersion); a missing `MCP-Protocol-Version`
 *   header or a header/body version conflict -> -32020 (HeaderMismatch).
 * - §6.3/§6.6: `Mcp-Session-Id` / `Last-Event-ID` are rejected, not ignored.
 * - §6.7: missing/duplicate/conflicting `Mcp-Method`/`Mcp-Name` or header/body
 *   mismatch -> -32020 (HeaderMismatch); missing required client capability
 *   -> -32021 (MissingRequiredClientCapability).
 * - §6.8: illegal `Mcp-Param-*` encoding, wrong Base64 sentinel, undeclared
 *   or disagreeing headers, and non-token `x-mcp-header` names are rejected.
 * - §6.10: `extensions` get structure/count/length budgets and stay inert
 *   (never enter authorization); trace `_meta` is bounded and tracing-only.
 *
 * SDK alignment: the Base64 sentinel codec and the `Mcp-Name`/`Mcp-Param-*`
 * validation below mirror `@modelcontextprotocol/client`'s
 * `encodeMcpParamValue`/`buildMcpParamHeaders` and `@modelcontextprotocol/server`'s
 * `decodeMcpParamValue`/`validateStandardRequestHeaders`/`validateMcpParamHeaders`
 * /`scanXMcpHeaderDeclarations` (pinned 2.3.1). The core production dependency
 * does NOT export those contract helpers (they live in the dev-only
 * client/server packages), so COLP implements the header codec itself — this
 * is a contract-layer codec, not a hand-written JSON-RPC/SSE engine.
 * `_meta` envelope requiredness mirrors the 2026 codec's
 * `validateEnvelopeMeta` (`protocolVersion` + `clientCapabilities` required),
 * with COLP's stricter version boundary above.
 *
 * Host-supplied trusted evidence (binding/scope/budget/abortSignal/
 * authorization) is validated through the shared trusted-context validator;
 * a malformed trusted input is a host bug and throws `TypeError`, while wire
 * facts fail with {@link Mcp20260728RequestError} carrying a stable wire code.
 */
import { types as nodeTypes } from 'node:util';

import { MCP_PROTOCOL_VERSION, supportedMcpProtocolVersions } from '../protocol-version.js';
import { snapshotMcpData } from '../safe-data.js';
import { assertMcpSchemaWithinBudget } from './schema-budget.js';
import {
  DEFAULT_HEADER_BUDGET,
  parseMcp20260728RequestHeaders,
  resolveHeaderBudget,
  type Mcp20260728HeaderBudget,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestHeaders,
} from './request-headers.js';
export { parseMcp20260728RequestHeaders } from './request-headers.js';
export type { Mcp20260728HeaderBudget, Mcp20260728HeaderField, Mcp20260728RequestHeaders } from './request-headers.js';
import type { McpAuthorizationBinding } from '../shared/authorization.js';
import type { McpResourceReadBudget } from '../shared/resources.js';
import {
  requireTrustedReadRequestContext,
  resolveMcpResourceReadBudget,
  type McpTrustedReadRequestContext,
} from '../shared/resources.js';
import {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  ImplementationSchema,
  LOG_LEVEL_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from '../../shared/mcp-sdk-boundary.js';

/** -32020: `HeaderMismatch` (SDK `HEADER_MISMATCH_ERROR_CODE`; SEP-2243). */
export const MCP_WIRE_HEADER_MISMATCH_ERROR_CODE = -32020 as const;
/** -32021: `MissingRequiredClientCapability` (SDK `ProtocolErrorCode`). */
export const MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE = -32021 as const;
/** -32022: `UnsupportedProtocolVersion` (SDK `ProtocolErrorCode`). */
export const MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE = -32022 as const;
/** -32600: JSON-RPC Invalid Request. */
export const MCP_WIRE_INVALID_REQUEST_ERROR_CODE = -32600 as const;
/** -32602: JSON-RPC Invalid Params (envelope/capability/trace/extension issues). */
export const MCP_WIRE_INVALID_PARAMS_ERROR_CODE = -32602 as const;
/** -32603: JSON-RPC Internal Error (low-sensitivity fallback). */
export const MCP_WIRE_INTERNAL_ERROR_CODE = -32603 as const;

/** Stable wire-error families the request adapter can emit. */
export type Mcp20260728WireErrorKind =
  | 'header_mismatch'
  | 'missing_required_client_capability'
  | 'unsupported_protocol_version'
  | 'invalid_params'
  | 'invalid_request'
  | 'internal_error';

const WIRE_CODE_BY_KIND: Readonly<Record<Mcp20260728WireErrorKind, number>> = Object.freeze({
  header_mismatch: MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  missing_required_client_capability: MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  unsupported_protocol_version: MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  invalid_params: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  invalid_request: MCP_WIRE_INVALID_REQUEST_ERROR_CODE,
  internal_error: MCP_WIRE_INTERNAL_ERROR_CODE,
});

/**
 * Typed request-contract failure. `wireCode` is the stable MCP `2026-07-28`
 * JSON-RPC error code a host transport should emit; `data` (when present)
 * carries low-sensitivity details only (never raw tokens/secrets).
 */
export class Mcp20260728RequestError extends Error {
  readonly kind: Mcp20260728WireErrorKind;
  readonly wireCode: number;
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(
    kind: Mcp20260728WireErrorKind,
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'Mcp20260728RequestError';
    this.kind = kind;
    this.wireCode = WIRE_CODE_BY_KIND[kind];
    if (data !== undefined) this.data = data;
  }
}

/** RFC 9110 §5.1 `token` syntax (`1*tchar`). */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/** Whether `value` is a valid HTTP field name per RFC 9110 (used by `x-mcp-header`). */
export function isMcp20260728Rfc9110Token(value: string): boolean {
  return RFC9110_TOKEN.test(value);
}

/**
 * Base64 sentinel codec for `Mcp-Name` / `Mcp-Param-*` field values (SEP-2243).
 *
 * A value that is a safe plain-ASCII HTTP field value passes through
 * unchanged; anything else (non-ASCII, leading/trailing whitespace, empty, or
 * already sentinel-shaped) is wrapped as `=?base64?{b64-of-utf8}?=` — the
 * spec's "to avoid ambiguity" rule. Mirrors the SDK client/server codec
 * (`encodeMcpParamValue` / `decodeMcpParamValue`) at the pinned 2.3.1.
 */
export const MCP_PARAM_BASE64_SENTINEL_PREFIX = '=?base64?' as const;
export const MCP_PARAM_BASE64_SENTINEL_SUFFIX = '?=' as const;
const MCP_PARAM_BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Whether `value` must be wrapped in the Base64 sentinel to be a safe field value. */
export function needsMcp20260728Base64Encoding(value: string): boolean {
  if (value.length === 0) return true;
  if (value.startsWith(MCP_PARAM_BASE64_SENTINEL_PREFIX) && value.endsWith(MCP_PARAM_BASE64_SENTINEL_SUFFIX)) {
    return true;
  }
  if (value !== value.trim()) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === 9 || (code !== undefined && code >= 32 && code <= 126)) continue;
    return true;
  }
  return false;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Encodes a string as a safe HTTP field value using the Base64 sentinel. */
export function encodeMcp20260728ParamValue(value: string): string {
  return needsMcp20260728Base64Encoding(value)
    ? `${MCP_PARAM_BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${MCP_PARAM_BASE64_SENTINEL_SUFFIX}`
    : value;
}

/**
 * Decodes an `Mcp-Param-*` / `Mcp-Name` field value: sentinel-carrying values
 * decode to UTF-8; plain values pass through. Returns `undefined` when a
 * sentinel payload is not canonical Base64 or valid UTF-8 (spec: reject).
 */
export function decodeMcp20260728ParamValue(value: string): string | undefined {
  if (!(value.startsWith(MCP_PARAM_BASE64_SENTINEL_PREFIX) && value.endsWith(MCP_PARAM_BASE64_SENTINEL_SUFFIX))) {
    return value;
  }
  const payload = value.slice(
    MCP_PARAM_BASE64_SENTINEL_PREFIX.length,
    value.length - MCP_PARAM_BASE64_SENTINEL_SUFFIX.length,
  );
  if (!MCP_PARAM_BASE64_CANONICAL.test(payload)) return undefined;
  try {
    return base64ToUtf8(payload);
  } catch {
    return undefined;
  }
}

export function headerMismatch(
  message: string,
  data?: Readonly<Record<string, unknown>>,
): Mcp20260728RequestError {
  return new Mcp20260728RequestError('header_mismatch', `Bad Request: the request headers and body disagree: ${message}`, data);
}

/**
 * Copy-paste request skeleton attached to envelope errors (`data.expected`)
 * so a client can repair the request from the first error response
 * (amended 2026-08-27).
 */
export const MCP_20260728_EXPECTED_ENVELOPE_HINT = Object.freeze({
  params: Object.freeze({
    _meta: Object.freeze({
      [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
      [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({}),
    }),
  }),
});

/** Required (and conditionally required) HTTP headers, mirrored into error data. */
export const MCP_20260728_REQUIRED_HEADERS_HINT = Object.freeze([
  'MCP-Protocol-Version: 2026-07-28',
  'Mcp-Method: <JSON-RPC body method>',
  'Mcp-Name: <params.name | params.uri> (tools/call, resources/read, prompts/get only)',
  'Accept: application/json, text/event-stream',
]);

/** Validated client implementation info (exact `Implementation` shape). */
export interface Mcp20260728ClientInfo {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
}

/** Log levels accepted for the per-request `_meta` log-level opt-in. */
export type Mcp20260728LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

const MCP_20260728_LOG_LEVELS: readonly Mcp20260728LogLevel[] = Object.freeze([
  'debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency',
]);

const LOG_LEVEL_SEVERITY: Readonly<Record<Mcp20260728LogLevel, number>> = Object.freeze({
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
});

/** Bounded W3C trace-context `_meta` facts (tracing only; never authorization). */
export interface Mcp20260728TraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

/** Budget for trace `_meta` values. */
export interface Mcp20260728TraceBudget {
  readonly maxValueBytes?: number;
}

const DEFAULT_TRACE_BUDGET: Required<Mcp20260728TraceBudget> = Object.freeze({ maxValueBytes: 4096 });

/** Budget for inert `_meta`/capability extension records. */
export interface Mcp20260728ExtensionBudget {
  readonly maxKeys?: number;
  readonly maxKeyBytes?: number;
  readonly maxValueBytes?: number;
}

const DEFAULT_EXTENSION_BUDGET: Required<Mcp20260728ExtensionBudget> = Object.freeze({
  maxKeys: 64,
  maxKeyBytes: 256,
  maxValueBytes: 8192,
});

const W3C_TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u;
const TRACE_KEY_VALUE_LIST = /^[^,\s=]+=[^,\s]+(?:,[^,\s=]+=[^,\s]+)*$/u;

/** Origin / transport evidence carried (bounded) by the request context. */
export interface Mcp20260728OriginEvidence {
  readonly origin?: string;
}

export interface Mcp20260728TransportEvidence {
  readonly httpMethod: string;
  readonly forwardedFor?: readonly string[];
}

/** Host-supplied inputs for building one per-request trusted context. */
export interface Mcp20260728RequestContextInput {
  /** Raw header fields (duplicates preserved so the adapter can reject them). */
  readonly headers: readonly Mcp20260728HeaderField[];
  /** HTTP method observed by the host transport (recorded as evidence). */
  readonly httpMethod: string;
  /** Parsed JSON-RPC body facts (method + params incl. `_meta`). */
  readonly body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>;
  /** Host-verified token-free authorization binding. */
  readonly binding: McpAuthorizationBinding;
  readonly scope?: readonly string[];
  readonly budget?: McpResourceReadBudget;
  readonly abortSignal?: AbortSignal;
  /** Opaque host residual authorization metadata (never wire facts). */
  readonly authorization?: Readonly<Record<string, unknown>>;
  /** Host-verified Origin header evidence (bounded). */
  readonly origin?: string;
  readonly forwardedFor?: readonly string[];
  /** `x-mcp-header` declarations for `Mcp-Param-*` validation (tools/call etc.). */
  readonly paramDeclarations?: readonly Mcp20260728XMcpHeaderDeclaration[];
  readonly headerBudget?: Mcp20260728HeaderBudget;
  readonly traceBudget?: Mcp20260728TraceBudget;
  readonly extensionBudget?: Mcp20260728ExtensionBudget;
}

/**
 * Trusted per-request MCP `2026-07-28` context. Extends the shared
 * protocol-neutral read context so it can be handed directly to the stateless
 * cores; adds validated Modern protocol facts (version, client info/
 * capabilities, log level, bounded trace) plus Origin/transport evidence.
 * Never stores a raw token, never persists as a protocol Session.
 */
export interface Mcp20260728RequestContext extends McpTrustedReadRequestContext {
  readonly protocolVersion: '2026-07-28';
  readonly clientInfo?: Mcp20260728ClientInfo;
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  readonly logLevel?: Mcp20260728LogLevel;
  readonly trace?: Mcp20260728TraceContext;
  /** Inert, budgeted unknown `_meta` keys — never used for authorization. */
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly originEvidence: Readonly<Mcp20260728OriginEvidence>;
  readonly transportEvidence: Readonly<Mcp20260728TransportEvidence>;
}

const RESERVED_META_KEYS: ReadonlySet<string> = new Set([
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  LOG_LEVEL_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
  'progressToken',
]);

interface ParsedEnvelope {
  readonly protocolVersion: '2026-07-28';
  readonly clientInfo?: Mcp20260728ClientInfo;
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  readonly logLevel?: Mcp20260728LogLevel;
  readonly trace?: Mcp20260728TraceContext;
  readonly extensions: Readonly<Record<string, unknown>>;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

function snapshotJsonValue(value: unknown, budget: Required<McpResourceReadBudget>): unknown {
  return snapshotMcpData(value, {
    maxDepth: budget.maxDepth,
    maxNodes: budget.maxNodes,
    maxBytes: budget.maxBytes,
    maxOperations: budget.maxOperations,
  });
}

function parseEnvelope(
  metaRaw: unknown,
  headers: Mcp20260728RequestHeaders,
  readBudget: Required<McpResourceReadBudget>,
  traceBudget: Required<Mcp20260728TraceBudget>,
  extensionBudget: Required<Mcp20260728ExtensionBudget>,
): ParsedEnvelope {
  if (!isPlainObject(metaRaw)) {
    // Missing required `_meta` fields are JSON-RPC Invalid Params (-32602)
    // per the upstream 2026-07-28 `_meta` contract; only an unsupported
    // version *value* is -32022 (MCP-0016 as amended 2026-08-27).
    throw new Mcp20260728RequestError(
      'invalid_params',
      'The request is missing the required per-request `_meta` envelope for protocol version 2026-07-28.',
      {
        expected: MCP_20260728_EXPECTED_ENVELOPE_HINT,
        requiredHeaders: MCP_20260728_REQUIRED_HEADERS_HINT,
      },
    );
  }
  const meta = metaRaw;
  const claimedVersion = readOwnValue(meta, PROTOCOL_VERSION_META_KEY);
  const headerVersion = headers.protocolVersion;
  // A conflicting MCP-Protocol-Version header is a header/body mismatch
  // (-32020, decision §6.7) even when the body envelope version itself is
  // unsupported. A body envelope that carries no string version claim is
  // missing a required `_meta` field (-32602); a string claim that is not
  // `2026-07-28` is UnsupportedProtocolVersion (-32022); a missing
  // MCP-Protocol-Version header — checked after the body envelope has been
  // validated — is a header fault (-32020, decision §6.1 as amended
  // 2026-08-27).
  if (headerVersion !== undefined && typeof claimedVersion === 'string' && headerVersion !== claimedVersion) {
    throw headerMismatch(
      `the request protocol version ${String(claimedVersion)} disagrees with the MCP-Protocol-Version header ${headerVersion}`,
    );
  }
  if (typeof claimedVersion !== 'string') {
    throw new Mcp20260728RequestError(
      'invalid_params',
      `The request _meta envelope is missing the required ${PROTOCOL_VERSION_META_KEY} field.`,
      { expected: MCP_20260728_EXPECTED_ENVELOPE_HINT },
    );
  }
  if (claimedVersion !== MCP_PROTOCOL_VERSION) {
    throw new Mcp20260728RequestError(
      'unsupported_protocol_version',
      `Unsupported protocol version: ${claimedVersion}`,
      { supported: supportedMcpProtocolVersions, requested: claimedVersion },
    );
  }
  if (headerVersion === undefined) {
    throw headerMismatch('the required MCP-Protocol-Version header is absent', {
      requiredHeaders: MCP_20260728_REQUIRED_HEADERS_HINT,
    });
  }

  const capabilitiesRaw = readOwnValue(meta, CLIENT_CAPABILITIES_META_KEY);
  if (!isPlainObject(capabilitiesRaw)) {
    throw new Mcp20260728RequestError(
      'invalid_params',
      `Invalid _meta envelope for protocol revision 2026-07-28: ${CLIENT_CAPABILITIES_META_KEY} must be an object.`,
      { expected: MCP_20260728_EXPECTED_ENVELOPE_HINT },
    );
  }
  let clientCapabilities: Readonly<Record<string, unknown>>;
  try {
    clientCapabilities = snapshotJsonValue(capabilitiesRaw, readBudget) as Readonly<Record<string, unknown>>;
  } catch {
    throw new Mcp20260728RequestError('invalid_params', 'clientCapabilities exceeds the request budget.');
  }

  const clientInfoRaw = readOwnValue(meta, CLIENT_INFO_META_KEY);
  let clientInfo: Mcp20260728ClientInfo | undefined;
  if (clientInfoRaw !== undefined) {
    const parsed = ImplementationSchema.safeParse(clientInfoRaw);
    if (!parsed.success) {
      throw new Mcp20260728RequestError('invalid_params', `Invalid _meta envelope for protocol revision 2026-07-28: ${CLIENT_INFO_META_KEY} is invalid.`);
    }
    clientInfo = Object.freeze(parsed.data) as Mcp20260728ClientInfo;
  }

  const logLevelRaw = readOwnValue(meta, LOG_LEVEL_META_KEY);
  let logLevel: Mcp20260728LogLevel | undefined;
  if (logLevelRaw !== undefined) {
    if (typeof logLevelRaw !== 'string' || !(MCP_20260728_LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
      throw new Mcp20260728RequestError('invalid_params', `Invalid _meta envelope for protocol revision 2026-07-28: ${LOG_LEVEL_META_KEY} is invalid.`);
    }
    logLevel = logLevelRaw as Mcp20260728LogLevel;
  }

  const trace = parseTraceMeta(meta, traceBudget);
  const extensions = parseExtensions(meta, extensionBudget);
  return Object.freeze({
    protocolVersion: MCP_PROTOCOL_VERSION,
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    clientCapabilities,
    ...(logLevel !== undefined ? { logLevel } : {}),
    ...(trace !== undefined ? { trace } : {}),
    extensions,
  }) as ParsedEnvelope;
}

function parseTraceMeta(
  meta: Readonly<Record<string, unknown>>,
  budget: Required<Mcp20260728TraceBudget>,
): Mcp20260728TraceContext | undefined {
  const traceparent = readOwnValue(meta, TRACEPARENT_META_KEY);
  const tracestate = readOwnValue(meta, TRACESTATE_META_KEY);
  const baggage = readOwnValue(meta, BAGGAGE_META_KEY);
  if (traceparent === undefined && tracestate === undefined && baggage === undefined) return undefined;
  if (traceparent !== undefined) {
    if (typeof traceparent !== 'string' || !W3C_TRACEPARENT.test(traceparent)) {
      throw new Mcp20260728RequestError('invalid_params', 'Invalid traceparent _meta value (W3C trace context).');
    }
  }
  for (const [key, value] of [
    [TRACESTATE_META_KEY, tracestate],
    [BAGGAGE_META_KEY, baggage],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > budget.maxValueBytes || !TRACE_KEY_VALUE_LIST.test(value)) {
      throw new Mcp20260728RequestError('invalid_params', `Invalid or over-budget ${key} _meta value.`);
    }
  }
  return Object.freeze({
    ...(traceparent !== undefined ? { traceparent } : {}),
    ...(tracestate !== undefined ? { tracestate } : {}),
    ...(baggage !== undefined ? { baggage } : {}),
  }) as Mcp20260728TraceContext;
}

function parseExtensions(
  meta: Readonly<Record<string, unknown>>,
  budget: Required<Mcp20260728ExtensionBudget>,
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(meta).filter(
    (key): key is string => typeof key === 'string' && !RESERVED_META_KEYS.has(key),
  );
  if (keys.length > budget.maxKeys) {
    throw new Mcp20260728RequestError('invalid_params', 'Too many unknown _meta extension keys.');
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.length > budget.maxKeyBytes) {
      throw new Mcp20260728RequestError('invalid_params', `Unknown _meta extension key exceeds the budget: ${key}.`);
    }
    const value = readOwnValue(meta, key);
    try {
      snapshot[key] = snapshotMcpData(value, {
        maxDepth: 32,
        maxNodes: 1_000,
        maxBytes: budget.maxValueBytes,
        maxOperations: 1_000,
      });
    } catch {
      throw new Mcp20260728RequestError('invalid_params', `Unknown _meta extension value exceeds the budget: ${key}.`);
    }
  }
  return Object.freeze(snapshot);
}

/** Methods whose body field the `Mcp-Name` header must mirror (SEP-2243). */
const MCP_NAME_HEADER_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
});

/** Strip RFC 9110 optional whitespace around a field value. */
function stripHttpOws(value: string): string {
  let start = 0;
  while (start < value.length) {
    const code = value.codePointAt(start);
    if (code !== 9 && code !== 32) break;
    start += 1;
  }
  let end = value.length;
  while (end > start) {
    const code = value.codePointAt(end - 1);
    if (code !== 9 && code !== 32) break;
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function validateMethodHeader(headers: Mcp20260728RequestHeaders, method: string): void {
  if (headers.method === undefined) {
    throw headerMismatch(`the body names method ${method} but the required Mcp-Method header is absent`, {
      requiredHeaders: MCP_20260728_REQUIRED_HEADERS_HINT,
    });
  }
  if (headers.method !== method) {
    throw headerMismatch(`the body names method ${method} but the Mcp-Method header names ${headers.method}`);
  }
}

function validateNameHeader(headers: Mcp20260728RequestHeaders, body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>): void {
  const sourceField = MCP_NAME_HEADER_SOURCE[body.method];
  if (sourceField === undefined) return;
  const params = body.params ?? {};
  const sourceValue = readOwnValue(params, sourceField);
  const bodyValue = typeof sourceValue === 'string' ? sourceValue : undefined;
  const nameHeader = headers.name;
  if (nameHeader === undefined) {
    if (bodyValue === undefined) return;
    throw headerMismatch(`the body carries params.${sourceField}="${bodyValue}" but the required Mcp-Name header is absent`, {
      requiredHeaders: MCP_20260728_REQUIRED_HEADERS_HINT,
    });
  }
  const normalized = stripHttpOws(nameHeader);
  const decoded = decodeMcp20260728ParamValue(normalized);
  if (decoded === undefined) {
    throw headerMismatch(`the Mcp-Name header carries an invalid Base64 sentinel value`);
  }
  if (bodyValue !== undefined && decoded !== bodyValue) {
    throw headerMismatch(`the body carries params.${sourceField}="${bodyValue}" but the Mcp-Name header names "${decoded}"`);
  }
}

/**
 * Builds the trusted per-request context from host evidence and wire facts.
 * Wire failures throw {@link Mcp20260728RequestError}; malformed host
 * evidence throws `TypeError` (host bug, fail closed).
 */
export function createMcp20260728RequestContext(
  input: Mcp20260728RequestContextInput,
): Mcp20260728RequestContext {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)) {
    throw new TypeError('MCP 2026-07-28 request context input must be an own-data object.');
  }
  const rawHeaderBudget = readOptional(input, 'headerBudget');
  const headerBudget = resolveHeaderBudget(
    rawHeaderBudget === undefined ? DEFAULT_HEADER_BUDGET : rawHeaderBudget as Mcp20260728HeaderBudget,
  );
  const headers = parseMcp20260728RequestHeaders(readHeaderFields(input), headerBudget);
  const body = readBodyFacts(input);
  const readBudget = resolveMcpResourceReadBudget(readOptional(input, 'budget') as McpResourceReadBudget | undefined);
  const traceBudget = resolveTraceBudget(readOptional(input, 'traceBudget'));
  const extensionBudget = resolveExtensionBudget(readOptional(input, 'extensionBudget'));

  const envelope = parseEnvelope(readBodyMeta(body), headers, readBudget, traceBudget, extensionBudget);
  validateMethodHeader(headers, body.method);
  validateNameHeader(headers, body);

  const declarations = readOptional(input, 'paramDeclarations');
  if (declarations !== undefined) {
    if (!Array.isArray(declarations)) throw new TypeError('paramDeclarations must be an array.');
    validateMcp20260728ParamHeaders(
      declarations as readonly Mcp20260728XMcpHeaderDeclaration[],
      body.method === 'tools/call'
        ? readToolsCallArguments(body.params)
        : body.params ?? {},
      headers.params,
    );
  }

  const shared = requireTrustedReadRequestContext(buildTrustedCandidate(input, readBudget));
  const origin = readOptional(input, 'origin');
  const forwardedFor = readOptional(input, 'forwardedFor');
  return Object.freeze({
    ...shared,
    protocolVersion: envelope.protocolVersion,
    ...(envelope.clientInfo !== undefined ? { clientInfo: envelope.clientInfo } : {}),
    clientCapabilities: envelope.clientCapabilities,
    ...(envelope.logLevel !== undefined ? { logLevel: envelope.logLevel } : {}),
    ...(envelope.trace !== undefined ? { trace: envelope.trace } : {}),
    extensions: envelope.extensions,
    originEvidence: Object.freeze({
      ...(typeof origin === 'string' && origin.length > 0 ? { origin } : {}),
    }),
    transportEvidence: Object.freeze({
      httpMethod: String(readOptional(input, 'httpMethod') ?? 'POST'),
      ...(Array.isArray(forwardedFor) && forwardedFor.length > 0
        ? { forwardedFor: Object.freeze([...forwardedFor]) }
        : {}),
    }),
  }) as Mcp20260728RequestContext;
}

function readHeaderFields(input: object): readonly Mcp20260728HeaderField[] {
  const fields = readOwnValue(input, 'headers');
  if (!Array.isArray(fields) || nodeTypes.isProxy(fields)) throw new TypeError('MCP request context input requires a headers array.');
  return fields as readonly Mcp20260728HeaderField[];
}

function readToolsCallArguments(
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const argumentsValue = params === undefined ? undefined : readOwnValue(params, 'arguments');
  if (!isPlainDataObject(argumentsValue)) {
    throw new Mcp20260728RequestError(
      'invalid_request',
      'The tools/call request params.arguments field must be an object when x-mcp-header declarations are present.',
    );
  }
  return argumentsValue;
}

function isPlainDataObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function readBodyFacts(input: object): Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }> {
  const body = readOwnValue(input, 'body');
  if (!isPlainObject(body)) throw new TypeError('MCP request context input requires a body object.');
  const method = readOwnValue(body, 'method');
  if (typeof method !== 'string' || method.length === 0) {
    throw new Mcp20260728RequestError('invalid_request', 'The request body must carry a non-empty JSON-RPC method.');
  }
  const params = readOwnValue(body, 'params');
  if (params !== undefined && !isPlainObject(params)) {
    throw new Mcp20260728RequestError('invalid_request', 'The request body params must be an object.');
  }
  return Object.freeze({
    method,
    ...(params !== undefined ? { params } : {}),
  }) as Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>;
}

function readBodyMeta(body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>): unknown {
  return body.params === undefined ? undefined : readOwnValue(body.params, '_meta');
}

function readOptional(input: object, name: string): unknown {
  return readOwnValue(input, name);
}

function resolveTraceBudget(budget: unknown): Required<Mcp20260728TraceBudget> {
  if (budget === undefined) return DEFAULT_TRACE_BUDGET;
  if (!isPlainObject(budget)) throw new TypeError('traceBudget must be an own-data object.');
  const raw = budget as Readonly<Record<string, unknown>>;
  const maxValueBytes = readLimit(raw, 'maxValueBytes', DEFAULT_TRACE_BUDGET.maxValueBytes);
  return Object.freeze({ maxValueBytes });
}

function resolveExtensionBudget(budget: unknown): Required<Mcp20260728ExtensionBudget> {
  if (budget === undefined) return DEFAULT_EXTENSION_BUDGET;
  if (!isPlainObject(budget)) throw new TypeError('extensionBudget must be an own-data object.');
  const raw = budget as Readonly<Record<string, unknown>>;
  return Object.freeze({
    maxKeys: readLimit(raw, 'maxKeys', DEFAULT_EXTENSION_BUDGET.maxKeys),
    maxKeyBytes: readLimit(raw, 'maxKeyBytes', DEFAULT_EXTENSION_BUDGET.maxKeyBytes),
    maxValueBytes: readLimit(raw, 'maxValueBytes', DEFAULT_EXTENSION_BUDGET.maxValueBytes),
  });
}

function readLimit(raw: Readonly<Record<string, unknown>>, name: string, fallback: number): number {
  const value = readOwnValue(raw, name);
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`MCP ${name} budget must be a safe positive integer.`);
  }
  return value as number;
}

function buildTrustedCandidate(
  input: object,
  readBudget: Required<McpResourceReadBudget>,
): Readonly<Record<string, unknown>> {
  const binding = readOwnValue(input, 'binding');
  const scope = readOwnValue(input, 'scope');
  const abortSignal = readOwnValue(input, 'abortSignal');
  const authorization = readOwnValue(input, 'authorization');
  return {
    binding,
    scope: Array.isArray(scope) ? scope : [],
    // The resolved default/validated read budget is the trusted budget; a
    // host that omits `budget` gets the shared safe defaults instead of an
    // undefined field the shared validator would reject.
    budget: readBudget,
    abortSignal: abortSignal ?? new AbortController().signal,
    authorization: authorization ?? {},
  };
}

/**
 * Strict re-validator: re-checks a `Mcp20260728RequestContext` shape and
 * returns a freshly frozen snapshot. Every adapter call re-validates the
 * current context; no context captured from an earlier request is reused.
 */
export function requireMcp20260728RequestContext(value: unknown): Mcp20260728RequestContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new Mcp20260728RequestError('invalid_request', 'MCP 2026-07-28 request context is invalid.');
  }
  const record = value as Readonly<Record<string, unknown>>;
  let shared: McpTrustedReadRequestContext;
  try {
    shared = requireTrustedReadRequestContext(value);
  } catch {
    throw new Mcp20260728RequestError('invalid_request', 'MCP 2026-07-28 request context trusted evidence is invalid.');
  }
  const protocolVersion = readOwnValue(record, 'protocolVersion');
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Mcp20260728RequestError(
      'unsupported_protocol_version',
      `Unsupported protocol version: ${String(protocolVersion)}`,
      { supported: supportedMcpProtocolVersions, requested: protocolVersion },
    );
  }
  const clientCapabilities = readOwnValue(record, 'clientCapabilities');
  if (!isPlainObject(clientCapabilities)) {
    throw new Mcp20260728RequestError('invalid_params', 'clientCapabilities must be an object.');
  }
  const clientInfoRaw = readOwnValue(record, 'clientInfo');
  let clientInfo: Mcp20260728ClientInfo | undefined;
  if (clientInfoRaw !== undefined) {
    const parsed = ImplementationSchema.safeParse(clientInfoRaw);
    if (!parsed.success) throw new Mcp20260728RequestError('invalid_params', 'clientInfo is invalid.');
    clientInfo = Object.freeze(parsed.data) as Mcp20260728ClientInfo;
  }
  const logLevelRaw = readOwnValue(record, 'logLevel');
  if (logLevelRaw !== undefined && !(MCP_20260728_LOG_LEVELS as readonly string[]).includes(logLevelRaw as string)) {
    throw new Mcp20260728RequestError('invalid_params', 'logLevel is invalid.');
  }
  const traceRaw = readOwnValue(record, 'trace');
  let trace: Mcp20260728TraceContext | undefined;
  if (traceRaw !== undefined) {
    if (!isPlainObject(traceRaw)) throw new Mcp20260728RequestError('invalid_params', 'trace context is invalid.');
    trace = parseTraceMeta(traceRaw, DEFAULT_TRACE_BUDGET);
  }
  const extensionsRaw = readOwnValue(record, 'extensions');
  if (!isPlainObject(extensionsRaw)) {
    throw new Mcp20260728RequestError('invalid_params', 'extensions must be an object.');
  }
  const originRaw = readOwnValue(record, 'originEvidence');
  const transportRaw = readOwnValue(record, 'transportEvidence');
  const originEvidence = isPlainObject(originRaw)
    ? (Object.freeze({ ...originRaw }) as Readonly<Mcp20260728OriginEvidence>)
    : Object.freeze({});
  const transportEvidence = isPlainObject(transportRaw)
    ? (Object.freeze({ ...transportRaw }) as Readonly<Mcp20260728TransportEvidence>)
    : Object.freeze({ httpMethod: 'POST' });
  return Object.freeze({
    ...shared,
    protocolVersion,
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    clientCapabilities: Object.freeze({ ...clientCapabilities }),
    ...(logLevelRaw !== undefined ? { logLevel: logLevelRaw } : {}),
    ...(trace !== undefined ? { trace } : {}),
    extensions: Object.freeze({ ...extensionsRaw }),
    originEvidence,
    transportEvidence,
  }) as Mcp20260728RequestContext;
}

/**
 * Enforces a required client capability, throwing the stable -32021
 * (`MissingRequiredClientCapability`) error when the per-request
 * `clientCapabilities` do not declare it. `capabilityPath` is a dotted path
 * such as `['resources', 'subscribe']` or `['extensions', 'vendor/x']`.
 */
export function requireMcp20260728ClientCapability(
  context: Mcp20260728RequestContext,
  capabilityPath: readonly string[],
): void {
  let node: unknown = context.clientCapabilities;
  for (const key of capabilityPath) {
    if (!isPlainObject(node)) {
      throw missingCapability(capabilityPath);
    }
    node = node[key];
  }
  if (node === undefined || node === null || node === false) {
    throw missingCapability(capabilityPath);
  }
}

function missingCapability(path: readonly string[]): Mcp20260728RequestError {
  let required: Record<string, unknown> = {};
  for (const key of path) required = { [key]: required };
  return new Mcp20260728RequestError(
    'missing_required_client_capability',
    `Missing required client capabilities: ${path.join('.')}`,
    { requiredCapabilities: required },
  );
}

/**
 * Per-request log guard: `notifications/message` may only be emitted when the
 * request opted in via `_meta` log level AND the message severity is at or
 * above the opted-in level (migration decision §6.9).
 */
export function mayEmitMcp20260728LogNotification(
  context: Mcp20260728RequestContext,
  level: Mcp20260728LogLevel,
): boolean {
  const optIn = context.logLevel;
  if (optIn === undefined) return false;
  return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[optIn];
}

/** One `x-mcp-header` declaration found in a tool `inputSchema`. */
export interface Mcp20260728XMcpHeaderDeclaration {
  readonly path: readonly string[];
  readonly headerName: string;
  readonly type: string;
}
export type Mcp20260728XMcpHeaderScanResult =
  | { readonly valid: true; readonly declarations: readonly Mcp20260728XMcpHeaderDeclaration[] }
  | { readonly valid: false; readonly reason: string };
const X_MCP_HEADER_KEY = 'x-mcp-header';
const PERMITTED_X_MCP_HEADER_TYPES: ReadonlySet<string> = new Set([
  'string',
  'integer',
  'boolean',
]);
const NON_REACHABLE_SUBSCHEMA_KEYWORDS: readonly string[] = [
  'items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas',
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions',
];
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
]);
function pathName(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}
/**
 * Scans a tool's JSON `inputSchema` for `x-mcp-header` declarations and
 * validates every spec constraint: non-empty RFC 9110 token name, permitted
 * primitive `type`, case-insensitive uniqueness, and static reachability via
 * a chain of `properties` keys only. Mirrors the SDK server's
 * `scanXMcpHeaderDeclarations` (pinned 2.3.1).
 */
export function scanMcp20260728XMcpHeaderDeclarations(
  inputSchema: unknown,
): Mcp20260728XMcpHeaderScanResult {
  try { assertMcpSchemaWithinBudget(inputSchema); }
  catch { return { valid: false, reason: 'Tool inputSchema exceeds the schema budget or is not JSON data.' }; }
  const declarations: Mcp20260728XMcpHeaderDeclaration[] = [];
  const seenLower = new Map<string, string>();
  const visit = (node: unknown, path: readonly string[], reachable: boolean): string | undefined => {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || nodeTypes.isProxy(node)) {
      return undefined;
    }
    const schema = node as Readonly<Record<string, unknown>>;
    if (Object.prototype.hasOwnProperty.call(schema, X_MCP_HEADER_KEY)) {
      if (!reachable || path.length === 0) {
        return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys`;
      }
      const raw = schema[X_MCP_HEADER_KEY];
      if (typeof raw !== 'string' || raw.length === 0) {
        return `${pathName(path)}: x-mcp-header MUST be a non-empty string`;
      }
      if (!isMcp20260728Rfc9110Token(raw)) {
        return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token`;
      }
      const type = typeof schema.type === 'string' ? schema.type : undefined;
      if (type === undefined || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) {
        return `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties; got ${type ?? '<none>'}`;
      }
      const lower = raw.toLowerCase();
      const prior = seenLower.get(lower);
      if (prior !== undefined) {
        return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
      }
      seenLower.set(lower, raw);
      declarations.push({ path, headerName: raw, type });
    }
    const properties = schema.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        const fault = visit(child, [...path, key], reachable);
        if (fault !== undefined) return fault;
      }
    }
    for (const keyword of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
      const sub = schema[keyword];
      if (sub === undefined) continue;
      const branches = Array.isArray(sub)
        ? sub
        : sub !== null && typeof sub === 'object' && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(keyword)
          ? Object.values(sub)
          : [sub];
      for (const branch of branches) {
        const fault = visit(branch, [...path, `<${keyword}>`], false);
        if (fault !== undefined) return fault;
      }
    }
    return undefined;
  };
  const fault = visit(inputSchema, [], true);
  return fault === undefined
    ? { valid: true, declarations }
    : { valid: false, reason: fault };
}
const CANONICAL_DECIMAL = /^-?\d+(\.\d+)?$/u;
function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Readonly<Record<string, unknown>>)[key];
  }
  return node;
}
function mcpParamPrimitiveToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
    return String(value);
  }
  return undefined;
}
function paramHeaderMismatch(header: string, body: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('header_mismatch', `Bad Request: the request headers and body disagree: ${body}`, {
    mismatch: { header, body },
  });
}

/**
 * Validates `Mcp-Param-*` headers against a tool's `x-mcp-header`
 * declarations and the body `arguments`: declared headers must be present and
 * decode to the body value when the body carries one (numeric comparison for
 * integer), headers not declared by the schema are rejected, and
 * sentinel values with invalid Base64/UTF-8 are rejected — all as -32020
 * (`HeaderMismatch`). Mirrors the SDK server's `validateMcpParamHeaders`.
 */
export function validateMcp20260728ParamHeaders(
  declarations: readonly Mcp20260728XMcpHeaderDeclaration[],
  args: unknown,
  headers: ReadonlyMap<string, string>,
): void {
  for (const decl of declarations) {
    if (!PERMITTED_X_MCP_HEADER_TYPES.has(decl.type)) {
      throw new TypeError(
        `x-mcp-header declarations only permit string, integer, or boolean; got ${decl.type}`,
      );
    }
  }
  const declared = new Set<string>();
  for (const decl of declarations) declared.add(decl.headerName.toLowerCase());
  for (const name of headers.keys()) {
    if (!declared.has(name)) {
      throw paramHeaderMismatch(
        `Mcp-Param-${name}`,
        `the ${name} header is not declared by the tool schema`,
      );
    }
  }
  for (const decl of declarations) {
    const headerKey = decl.headerName.toLowerCase();
    const headerValue = headers.get(headerKey);
    const bodyRaw = valueAtPath(args, decl.path);
    if (bodyRaw === undefined || bodyRaw === null) continue;
    const bodyString = mcpParamPrimitiveToString(bodyRaw);
    if (bodyString === undefined) continue;
    if (headerValue === undefined) {
      throw paramHeaderMismatch(
        `Mcp-Param-${decl.headerName}`,
        `the body carries ${pathName(decl.path)}=${JSON.stringify(bodyRaw)} but the ${decl.headerName} header is absent`,
      );
    }
    const decoded = decodeMcp20260728ParamValue(stripHttpOws(headerValue));
    if (decoded === undefined) {
      throw paramHeaderMismatch(
        `Mcp-Param-${decl.headerName}`,
        `the ${decl.headerName} header carries an invalid Base64 sentinel value`,
      );
    }
    const numericMatch =
      decl.type === 'integer'
      && CANONICAL_DECIMAL.test(decoded)
      && typeof bodyRaw === 'number'
      && Number(decoded) === bodyRaw;
    if (!(numericMatch || decoded === bodyString)) {
      throw paramHeaderMismatch(
        `Mcp-Param-${decl.headerName}`,
        `the ${decl.headerName} header decodes to ${JSON.stringify(decoded)} but the body carries ${pathName(decl.path)}=${JSON.stringify(bodyRaw)}`,
      );
    }
  }
}
