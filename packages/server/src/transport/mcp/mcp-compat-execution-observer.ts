/**
 * MCP-CQ-05 per-request execution observer for `/collections/-/mcp-compat`.
 *
 * SDK/execution classes are `ok | rejected | dependency_error | cancelled`.
 * Admission still publishes the existing 7-outcome metric allowlist
 * (`auth_required`, `forbidden`, `rate_limited`, …). The observer stores only
 * those low-cardinality enums — never messages, input, tokens, URLs, or
 * canaries. Unclassified requests throw in test and finish as
 * `dependency_error` in production; they never default to `ok`.
 */
import type { ServerResponse } from 'node:http';
import {
  type McpCompatAuth,
  type McpCompatEra,
  type McpCompatMethodFamily,
  type McpCompatOutcome,
  type McpCompatProtocolRevision,
  type McpCompatRejectCategory,
  type Phase4bMcpCompatHandshakeRecord,
  type Phase4bMcpCompatRequestFinish,
} from '../../modules/mcp/index.js';

export type McpCompatExecutionClass = 'ok' | 'rejected' | 'dependency_error' | 'cancelled';

export type McpCompatHijackedRpcClass =
  | 'empty'
  | 'result_ok'
  | 'result_is_error'
  | 'jsonrpc_error'
  | 'jsonrpc_internal_error'
  | 'unparseable';

const JSONRPC_INTERNAL_ERROR_CODE = -32_603;
const HIJACK_BODY_LIMIT_BYTES = 65_536;

export class McpCompatUnclassifiedExecutionError extends Error {
  constructor() {
    super('MCP compat request ended unclassified');
    this.name = 'McpCompatUnclassifiedExecutionError';
  }
}

export interface McpCompatExecutionObserver {
  observeAdmission(input: {
    readonly outcome: McpCompatOutcome;
    readonly rejectCategory?: McpCompatRejectCategory;
    readonly protocolRevision: McpCompatProtocolRevision;
    readonly era?: McpCompatEra;
  }): void;
  observeExecution(execution: McpCompatExecutionClass): void;
  observeUnsupportedModern(): void;
  observeBatchRejected(): void;
  observeHijacked(input: {
    readonly statusCode: number;
    readonly rpc: McpCompatHijackedRpcClass;
  }): void;
  toFinish(context: {
    readonly methodFamily: McpCompatMethodFamily;
    readonly auth: McpCompatAuth;
    readonly handshake?: Phase4bMcpCompatHandshakeRecord;
    readonly aborted: boolean;
  }): Phase4bMcpCompatRequestFinish;
}

export function createMcpCompatExecutionObserver(): McpCompatExecutionObserver {
  let classified = false;
  let admission = false;
  let outcome: McpCompatOutcome | undefined;
  let execution: McpCompatExecutionClass | undefined;
  let protocolRevision: McpCompatProtocolRevision = '2025-11-25';
  let era: McpCompatEra = 'legacy';
  let rejectCategory: McpCompatRejectCategory | undefined;

  const assignNonOk = (input: {
    readonly outcome: McpCompatOutcome;
    readonly execution: McpCompatExecutionClass;
    readonly protocolRevision?: McpCompatProtocolRevision;
    readonly era?: McpCompatEra;
    readonly rejectCategory?: McpCompatRejectCategory;
  }): void => {
    if (classified && execution !== 'ok' && outcome !== 'ok') return;
    classified = true;
    outcome = input.outcome;
    execution = input.execution;
    if (input.protocolRevision !== undefined) protocolRevision = input.protocolRevision;
    if (input.era !== undefined) era = input.era;
    rejectCategory = input.rejectCategory;
  };

  const observer: McpCompatExecutionObserver = {
    observeAdmission(input) {
      admission = true;
      classified = true;
      outcome = input.outcome;
      execution = executionFromMetricOutcome(input.outcome);
      protocolRevision = input.protocolRevision;
      era = input.era ?? 'legacy';
      rejectCategory = input.rejectCategory;
    },
    observeExecution(next) {
      if (next === 'ok') {
        if (classified) return;
        classified = true;
        execution = 'ok';
        outcome = 'ok';
        return;
      }
      assignNonOk({
        outcome: next,
        execution: next,
      });
    },
    observeUnsupportedModern() {
      assignNonOk({
        outcome: 'rejected',
        execution: 'rejected',
        era: 'modern',
        protocolRevision: 'unsupported',
        rejectCategory: 'unsupported',
      });
    },
    observeBatchRejected() {
      assignNonOk({
        outcome: 'rejected',
        execution: 'rejected',
        era: 'legacy',
        protocolRevision: '2025-11-25',
        rejectCategory: 'admission',
      });
    },
    observeHijacked(input) {
      const next = executionFromHijacked(input);
      if (next === undefined) return;
      observer.observeExecution(next);
    },
    toFinish(context) {
      if (admission && outcome !== undefined) {
        return buildFinish(context, {
          outcome,
          protocolRevision,
          era,
          rejectCategory,
        });
      }
      if (context.aborted) {
        return buildFinish(context, {
          outcome: 'cancelled',
          protocolRevision: '2025-11-25',
          era: 'legacy',
        });
      }
      if (!classified || outcome === undefined) {
        if (process.env.NODE_ENV === 'test') {
          throw new McpCompatUnclassifiedExecutionError();
        }
        return buildFinish(context, {
          outcome: 'dependency_error',
          protocolRevision: '2025-11-25',
          era: 'legacy',
        });
      }
      return buildFinish(context, {
        outcome,
        protocolRevision,
        era,
        rejectCategory,
      });
    },
  };
  return Object.freeze(observer);
}

export function classifyMcpCompatHijackedBody(body: string): McpCompatHijackedRpcClass {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'empty';
  const payload = extractJsonRpcPayload(trimmed);
  if (payload === undefined) return 'unparseable';
  return classifyJsonRpcRecord(payload);
}

export function attachMcpCompatHijackObserver(
  res: ServerResponse,
  observer: McpCompatExecutionObserver,
): { readonly flush: () => void } {
  const chunks: Buffer[] = [];
  let captured = 0;
  let flushed = false;

  const take = (chunk: unknown, encodingOrCb: unknown): void => {
    if (captured >= HIJACK_BODY_LIMIT_BYTES) return;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb as BufferEncoding : undefined;
    const buffer = bufferFromChunk(chunk, encoding);
    if (buffer === undefined || buffer.length === 0) return;
    const slice = buffer.byteLength + captured > HIJACK_BODY_LIMIT_BYTES
      ? buffer.subarray(0, HIJACK_BODY_LIMIT_BYTES - captured)
      : buffer;
    chunks.push(slice);
    captured += slice.byteLength;
  };

  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    const body = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0;
    observer.observeHijacked({
      statusCode: res.statusCode,
      rpc: classifyMcpCompatHijackedBody(body),
    });
  };

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = ((
    chunk?: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ) => {
    take(chunk, encodingOrCb);
    return originalWrite(chunk as never, encodingOrCb as never, cb as never);
  }) as typeof res.write;
  res.end = ((
    chunk?: unknown,
    encodingOrCb?: unknown,
    cb?: unknown,
  ) => {
    take(chunk, encodingOrCb);
    flush();
    return originalEnd(chunk as never, encodingOrCb as never, cb as never);
  }) as typeof res.end;

  return Object.freeze({ flush });
}

function executionFromMetricOutcome(outcome: McpCompatOutcome): McpCompatExecutionClass {
  if (outcome === 'ok' || outcome === 'dependency_error' || outcome === 'cancelled') return outcome;
  return 'rejected';
}

function executionFromHijacked(input: {
  readonly statusCode: number;
  readonly rpc: McpCompatHijackedRpcClass;
}): McpCompatExecutionClass | undefined {
  switch (input.rpc) {
    case 'result_ok':
      return 'ok';
    case 'result_is_error':
    case 'jsonrpc_error':
      return 'rejected';
    case 'jsonrpc_internal_error':
      return 'dependency_error';
    case 'empty':
      if (input.statusCode >= 200 && input.statusCode < 300) return 'ok';
      if (input.statusCode >= 500) return 'dependency_error';
      if (input.statusCode >= 400) return 'rejected';
      return undefined;
    case 'unparseable':
      if (input.statusCode >= 500) return 'dependency_error';
      if (input.statusCode >= 400) return 'rejected';
      return undefined;
    default:
      return undefined;
  }
}

function extractJsonRpcPayload(body: string): unknown {
  if (looksLikeSse(body)) {
    for (const block of body.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (data.length === 0 || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as unknown;
          if (isJsonRpcEnvelope(parsed)) return parsed;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeSse(body: string): boolean {
  return body.startsWith('event:') || body.startsWith('data:') || body.includes('\ndata:');
}

function isJsonRpcEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { readonly jsonrpc?: unknown; readonly result?: unknown; readonly error?: unknown };
  return record.jsonrpc === '2.0' || 'result' in record || 'error' in record;
}

function classifyJsonRpcRecord(value: unknown): McpCompatHijackedRpcClass {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unparseable';
  const record = value as { readonly result?: unknown; readonly error?: unknown };
  if (record.error !== undefined && record.error !== null) {
    if (typeof record.error === 'object' && !Array.isArray(record.error)) {
      const code = (record.error as { readonly code?: unknown }).code;
      if (code === JSONRPC_INTERNAL_ERROR_CODE) return 'jsonrpc_internal_error';
    }
    return 'jsonrpc_error';
  }
  if ('result' in record) {
    const result = record.result;
    if (result !== null && typeof result === 'object' && !Array.isArray(result)
      && (result as { readonly isError?: unknown }).isError === true) {
      return 'result_is_error';
    }
    return 'result_ok';
  }
  return 'unparseable';
}

function bufferFromChunk(chunk: unknown, encoding: BufferEncoding | undefined): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return undefined;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  return undefined;
}

function buildFinish(
  context: {
    readonly methodFamily: McpCompatMethodFamily;
    readonly auth: McpCompatAuth;
    readonly handshake?: Phase4bMcpCompatHandshakeRecord;
    readonly aborted: boolean;
  },
  classified: {
    readonly outcome: McpCompatOutcome;
    readonly protocolRevision: McpCompatProtocolRevision;
    readonly era: McpCompatEra;
    readonly rejectCategory?: McpCompatRejectCategory;
  },
): Phase4bMcpCompatRequestFinish {
  return {
    outcome: classified.outcome,
    methodFamily: context.methodFamily,
    auth: context.auth,
    era: classified.era,
    protocolRevision: classified.protocolRevision,
    ...(classified.rejectCategory === undefined ? {} : { rejectCategory: classified.rejectCategory }),
    ...(context.handshake === undefined ? {} : { handshake: context.handshake }),
  };
}
