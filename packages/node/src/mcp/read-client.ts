import type { McpReadToolResult } from './collections-get.js';
import { snapshotMcpData } from './safe-data.js';

export type McpReadClientCallStatus = 'succeeded' | 'failed' | 'timed_out' | 'rejected';

export interface McpReadClientCall {
  readonly toolName: 'collections.get';
  readonly input: Readonly<{ collectionId: string }>;
  readonly targetCollectionId: string;
}

export interface McpReadClientRecord {
  readonly toolName: 'collections.get' | '[rejected]';
  readonly status: McpReadClientCallStatus;
  readonly targetCollectionId?: string;
}

/**
 * Read application client gateway port.
 *
 * This port owns the transport + OAuth client composition for the Read
 * application client: the host wires the HTTP transport, the OAuth client flow
 * (RFC 9207 `iss`, RFC 7591 DCR, PKCE S256, issuer-keyed credential/refresh
 * state — see `src/security/mcp-oauth-client.ts`) and the token store behind
 * this single `callTool` boundary. The Read application client never receives
 * a token store handle and never sees raw tokens or client secrets: the
 * gateway presents only a resolved, authorized tool call. Hosts keep the
 * credential vault / token store behind the gateway-owned ports
 * (`OAuthClientCredentialVaultPort` / `OAuthClientTokenStorePort`).
 *
 * The strict options validator in `createMcpReadClient` rejects any extra
 * field, so a token store cannot be smuggled into the client even at runtime.
 */
export interface McpReadClientGatewayPort {
  readonly callTool: (name: string, input: unknown) => unknown | PromiseLike<unknown>;
}

export interface McpReadClientPresenterPort {
  readonly displayToolCall: (call: McpReadClientCall) => unknown | PromiseLike<unknown>;
}

export interface McpReadClientRecorderPort {
  readonly recordToolCall: (record: McpReadClientRecord) => unknown | PromiseLike<unknown>;
}

export interface McpReadClientResultValidatorPort {
  readonly validateToolResult: (name: 'collections.get', result: unknown) => unknown;
}

export interface McpReadClientTargetResolverPort {
  readonly resolveTargetCollection: (
    name: 'collections.get',
    input: Readonly<{ collectionId: string }>,
  ) => string;
}

export interface McpReadClientOptions {
  readonly gateway: McpReadClientGatewayPort;
  readonly presenter: McpReadClientPresenterPort;
  readonly recorder: McpReadClientRecorderPort;
  readonly resultValidator: McpReadClientResultValidatorPort;
  readonly targetResolver: McpReadClientTargetResolverPort;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
}

export interface McpReadClient {
  readonly callTool: (name: string, input: unknown) => Promise<McpReadToolResult>;
}

export class McpReadClientConfigurationError extends TypeError {
  readonly code = 'invalid_read_client_configuration' as const;

  constructor() {
    super('Invalid MCP read client configuration.');
    this.name = 'McpReadClientConfigurationError';
  }
}

export class McpReadClientError extends Error {
  readonly code: 'read_client_call_rejected' | 'read_client_call_failed' | 'read_client_call_timed_out' | 'read_client_result_too_large';

  constructor(kind: 'rejected' | 'failed' | 'timed_out' | 'result_too_large') {
    const detail = kind === 'rejected'
      ? ['MCP Tool call rejected.', 'read_client_call_rejected'] as const
      : kind === 'timed_out'
        ? ['MCP Tool call timed out.', 'read_client_call_timed_out'] as const
        : kind === 'result_too_large'
          ? ['MCP Tool result exceeds maximum size.', 'read_client_result_too_large'] as const
          : ['MCP Tool call failed.', 'read_client_call_failed'] as const;
    super(detail[0]);
    this.name = 'McpReadClientError';
    this.code = detail[1];
  }
}

type Callable = (...args: never[]) => unknown;
interface BoundFunction { readonly receiver: object; readonly fn: Callable }

/** Creates a read-only client for the sole implemented low-risk MCP Tool. */
export function createMcpReadClient(options: McpReadClientOptions): McpReadClient {
  assertExactObject(options, [
    'gateway',
    'presenter',
    'recorder',
    'resultValidator',
    'targetResolver',
    'timeoutMs',
    'maxResultBytes',
  ]);
  const gateway = readPort(options.gateway, 'callTool');
  const presenter = readPort(options.presenter, 'displayToolCall');
  const recorder = readPort(options.recorder, 'recordToolCall');
  const resultValidator = readPort(options.resultValidator, 'validateToolResult');
  const targetResolver = readPort(options.targetResolver, 'resolveTargetCollection');
  const timeoutMs = positiveSafeInteger(readData(options, 'timeoutMs'));
  const maxResultBytes = positiveSafeInteger(readData(options, 'maxResultBytes'));

  const callTool = Object.freeze(async (...args: [name: string, input: unknown]): Promise<McpReadToolResult> => {
    let status: McpReadClientCallStatus = 'rejected';
    let recordedTool: McpReadClientRecord['toolName'] = '[rejected]';
    let targetCollectionId: string | undefined;
    let failure: 'rejected' | 'failed' | 'timed_out' | 'result_too_large' | undefined;
    let returned: McpReadToolResult | undefined;

    try {
      if (args[0] === 'collections.get') recordedTool = 'collections.get';
      if (args.length !== 2 || recordedTool !== 'collections.get') throw rejectedMarker;
      const input = snapshotReadInput(args[1]);
      status = 'failed';
      const target = Reflect.apply(targetResolver.fn, targetResolver.receiver, [recordedTool, input]);
      if (typeof target !== 'string' || target.length === 0) throw failedMarker;
      targetCollectionId = target;

      const display = Object.freeze({ toolName: recordedTool, input, targetCollectionId });
      await Reflect.apply(presenter.fn, presenter.receiver, [display]);

      let gatewayResult: unknown;
      try {
        gatewayResult = await withTimeout(
          Promise.resolve(Reflect.apply(gateway.fn, gateway.receiver, [recordedTool, input])),
          timeoutMs,
        );
      } catch (error) {
        if (error === timeoutMarker) throw timeoutMarker;
        throw failedMarker;
      }

      const detachedGatewayResult = snapshotMcpData(gatewayResult);
      const validated = Reflect.apply(
        resultValidator.fn,
        resultValidator.receiver,
        [recordedTool, detachedGatewayResult],
      );
      if (validated === false || validated === null || validated === undefined) throw failedMarker;
      const safeValidated = snapshotResult(validated);
      const serialized = JSON.stringify(safeValidated);
      if (Buffer.byteLength(serialized, 'utf8') > maxResultBytes) throw sizeMarker;
      returned = safeValidated;
      status = 'succeeded';
    } catch (error) {
      if (error === rejectedMarker) {
        status = 'rejected';
        failure = 'rejected';
      } else if (error === timeoutMarker) {
        status = 'timed_out';
        failure = 'timed_out';
      } else if (error === sizeMarker) {
        status = 'failed';
        failure = 'result_too_large';
      } else {
        failure = status === 'rejected' ? 'rejected' : 'failed';
        if (status !== 'rejected') status = 'failed';
      }
    }

    const record = Object.freeze(targetCollectionId === undefined
      ? { toolName: recordedTool, status }
      : { toolName: recordedTool, status, targetCollectionId });
    try {
      await Reflect.apply(recorder.fn, recorder.receiver, [record]);
    } catch {
      throw new McpReadClientError('failed');
    }
    if (failure !== undefined) throw new McpReadClientError(failure);
    if (returned === undefined) throw new McpReadClientError('failed');
    return returned;
  });

  return Object.freeze({ callTool });
}

const rejectedMarker = Object.freeze({});
const failedMarker = Object.freeze({});
const timeoutMarker = Object.freeze({});
const sizeMarker = Object.freeze({});

function withTimeout<Value>(pending: Promise<Value>, timeoutMs: number): Promise<Value> {
  return new Promise((resolve, reject) => {
    let remainingMs = timeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const delayMs = Math.min(remainingMs, 2_147_483_647);
      timer = setTimeout(() => {
        remainingMs -= delayMs;
        if (remainingMs <= 0) reject(timeoutMarker);
        else schedule();
      }, delayMs);
    };
    schedule();
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function snapshotReadInput(input: unknown): Readonly<{ collectionId: string }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw rejectedMarker;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw rejectedMarker;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== 'collectionId') throw rejectedMarker;
  const descriptor = descriptors.collectionId;
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || descriptor.enumerable !== true
    || typeof descriptor.value !== 'string'
  ) {
    throw rejectedMarker;
  }
  return Object.freeze({ collectionId: descriptor.value });
}

function snapshotResult(value: unknown): McpReadToolResult {
  const snapshot = snapshotMcpData(value);
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw failedMarker;
  if (!Object.hasOwn(snapshot, 'structuredContent')) throw failedMarker;
  return snapshot as McpReadToolResult;
}

function readPort(value: unknown, method: string): BoundFunction {
  assertExactObject(value, [method]);
  const fn = readData(value, method);
  if (typeof fn !== 'function') throw configurationError();
  return Object.freeze({ receiver: value, fn: fn as Callable });
}

function assertExactObject(value: unknown, keys: readonly string[]): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw configurationError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw configurationError();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw configurationError();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw configurationError();
    }
  }
}

function readData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) throw configurationError();
  return descriptor.value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw configurationError();
  return value;
}

function configurationError(): McpReadClientConfigurationError {
  return new McpReadClientConfigurationError();
}
