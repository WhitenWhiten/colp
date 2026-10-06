import { types as nodeTypes } from 'node:util';

import { supportedMcpProtocolVersions } from '../protocol-version.js';
import {
  decodeMcp20260728ParamValue,
  MCP_PARAM_BASE64_SENTINEL_PREFIX,
  MCP_PARAM_BASE64_SENTINEL_SUFFIX,
  Mcp20260728RequestError,
  headerMismatch,
} from './request-context.js';

/** One raw HTTP header field (host-extracted; duplicates are preserved). */
export interface Mcp20260728HeaderField {
  readonly name: string;
  readonly value: string;
}

/** Raw transport-header budgets enforced before normalization or decoding. */
export interface Mcp20260728HeaderBudget {
  readonly maxFields?: number;
  readonly maxTotalBytes?: number;
  readonly maxNameBytes?: number;
  readonly maxValueBytes?: number;
  readonly maxParamFields?: number;
  readonly maxDecodedValueBytes?: number;
}

export const DEFAULT_HEADER_BUDGET: Required<Mcp20260728HeaderBudget> = Object.freeze({
  maxFields: 128,
  maxTotalBytes: 64 * 1024,
  maxNameBytes: 1024,
  maxValueBytes: 16 * 1024,
  maxParamFields: 64,
  maxDecodedValueBytes: 8 * 1024,
});

/** Normalised Modern MCP headers. */
export interface Mcp20260728RequestHeaders {
  readonly protocolVersion?: string;
  readonly method?: string;
  readonly name?: string;
  readonly params: ReadonlyMap<string, string>;
}

const MCP_METHOD_HEADER = 'mcp-method';
const MCP_NAME_HEADER = 'mcp-name';
const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
const MCP_PARAM_HEADER_PREFIX = 'mcp-param-';
const LEGACY_MCP_HEADERS = Object.freeze(['mcp-session-id', 'last-event-id']);

/**
 * Parses raw header fields into normalised MCP headers while enforcing count,
 * byte, duplicate, legacy-header, and decoded-value budgets.
 */
export function parseMcp20260728RequestHeaders(
  fields: readonly Mcp20260728HeaderField[],
  budget: Mcp20260728HeaderBudget = DEFAULT_HEADER_BUDGET,
): Mcp20260728RequestHeaders {
  const limits = resolveHeaderBudget(budget);
  if (!Array.isArray(fields) || nodeTypes.isProxy(fields)) {
    throw new TypeError('MCP header fields must be an own-data array.');
  }
  if (fields.length > limits.maxFields) {
    throw headerMismatch(`the request carries more than ${limits.maxFields} header fields`);
  }
  let protocolVersion: string | undefined;
  let method: string | undefined;
  let name: string | undefined;
  const params = new Map<string, string>();
  let totalBytes = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(fields, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw headerMismatch('header fields must be dense own-data entries');
    }
    const field: unknown = descriptor.value;
    if (typeof field !== 'object' || field === null || nodeTypes.isProxy(field)) {
      throw headerMismatch('a header field is not an own-data object');
    }
    const nameDescriptor = Object.getOwnPropertyDescriptor(field, 'name');
    const valueDescriptor = Object.getOwnPropertyDescriptor(field, 'value');
    if (
      nameDescriptor === undefined || valueDescriptor === undefined
      || !('value' in nameDescriptor) || !('value' in valueDescriptor)
      || typeof nameDescriptor.value !== 'string' || typeof valueDescriptor.value !== 'string'
    ) {
      throw headerMismatch('a header field must contain string name and value data');
    }
    const fieldName = nameDescriptor.value;
    const fieldValue = valueDescriptor.value;
    // UTF-8 is at least as long as the UTF-16 code-unit count. Reject large
    // strings before scanning them, and count bytes without allocating a copy.
    if (fieldName.length > limits.maxNameBytes || fieldValue.length > limits.maxValueBytes) {
      throw headerMismatch('a header name or value exceeds its byte limit');
    }
    const nameBytes = utf8ByteLength(fieldName);
    const valueBytes = utf8ByteLength(fieldValue);
    if (nameBytes > limits.maxNameBytes) {
      throw headerMismatch(`a header name exceeds the ${limits.maxNameBytes}-byte limit`);
    }
    if (valueBytes > limits.maxValueBytes) {
      throw headerMismatch(`a header value exceeds the ${limits.maxValueBytes}-byte limit`);
    }
    totalBytes += nameBytes + valueBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw headerMismatch(`request headers exceed the ${limits.maxTotalBytes}-byte limit`);
    }
    const key = fieldName.toLowerCase();
    if (LEGACY_MCP_HEADERS.includes(key as 'mcp-session-id' | 'last-event-id')) {
      throw new Mcp20260728RequestError(
        'unsupported_protocol_version',
        `Legacy MCP header '${fieldName}' is not supported by protocol version 2026-07-28.`,
        { supported: supportedMcpProtocolVersions, header: fieldName },
      );
    }
    if (key === MCP_PROTOCOL_VERSION_HEADER) {
      if (protocolVersion !== undefined) throw headerMismatch('duplicate MCP-Protocol-Version header');
      protocolVersion = fieldValue;
    } else if (key === MCP_METHOD_HEADER) {
      if (method !== undefined) throw headerMismatch('duplicate Mcp-Method header');
      method = fieldValue;
    } else if (key === MCP_NAME_HEADER) {
      if (name !== undefined) throw headerMismatch('duplicate Mcp-Name header');
      assertDecodedHeaderBudget(fieldName, fieldValue, limits);
      name = fieldValue;
    } else if (key.startsWith(MCP_PARAM_HEADER_PREFIX)) {
      const suffix = key.slice(MCP_PARAM_HEADER_PREFIX.length);
      if (suffix.length === 0) throw headerMismatch('empty Mcp-Param- header name');
      if (params.has(suffix)) throw headerMismatch(`duplicate Mcp-Param-${suffix} header`);
      if (params.size >= limits.maxParamFields) {
        throw headerMismatch(`the request carries more than ${limits.maxParamFields} parameter headers`);
      }
      assertDecodedHeaderBudget(`Mcp-Param-${suffix}`, fieldValue, limits);
      params.set(suffix, fieldValue);
    }
  }
  return Object.freeze({
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(name !== undefined ? { name } : {}),
    params,
  }) as Mcp20260728RequestHeaders;
}

function assertDecodedHeaderBudget(
  label: string,
  value: string,
  limits: Required<Mcp20260728HeaderBudget>,
): void {
  const normalized = stripHttpOws(value);
  if (
    !normalized.startsWith(MCP_PARAM_BASE64_SENTINEL_PREFIX)
    || !normalized.endsWith(MCP_PARAM_BASE64_SENTINEL_SUFFIX)
  ) {
    if (utf8ByteLength(normalized) > limits.maxDecodedValueBytes) {
      throw headerMismatch(`${label} exceeds the decoded-value budget`);
    }
    return;
  }
  const payloadBytes = normalized.length - MCP_PARAM_BASE64_SENTINEL_PREFIX.length
    - MCP_PARAM_BASE64_SENTINEL_SUFFIX.length;
  if (payloadBytes > Math.ceil(limits.maxDecodedValueBytes * 4 / 3) + 4) {
    throw headerMismatch(`${label} exceeds the decoded-value budget`);
  }
  const decoded = decodeMcp20260728ParamValue(normalized);
  if (decoded === undefined || utf8ByteLength(decoded) > limits.maxDecodedValueBytes) {
    throw headerMismatch(`${label} exceeds the decoded-value budget`);
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function stripHttpOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}

export function resolveHeaderBudget(budget: Mcp20260728HeaderBudget): Required<Mcp20260728HeaderBudget> {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget) || nodeTypes.isProxy(budget)) {
    throw new TypeError('MCP header budget must be an own-data object.');
  }
  const read = (name: keyof Mcp20260728HeaderBudget): number => {
    const value = readOwnValue(budget, name);
    const fallback = DEFAULT_HEADER_BUDGET[name] as number;
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > fallback) {
      throw new TypeError(`MCP ${name} budget must be between 1 and ${fallback}.`);
    }
    return value;
  };
  return Object.freeze({
    maxFields: read('maxFields'),
    maxTotalBytes: read('maxTotalBytes'),
    maxNameBytes: read('maxNameBytes'),
    maxValueBytes: read('maxValueBytes'),
    maxParamFields: read('maxParamFields'),
    maxDecodedValueBytes: read('maxDecodedValueBytes'),
  });
}

function readOwnValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}
