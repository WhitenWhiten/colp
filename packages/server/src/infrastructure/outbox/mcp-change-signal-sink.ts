/**
 * P4B-R11 Outbox-to-MCP change-signal sink wrapper.
 *
 * The wrapper preserves the existing projection sink's explicit durability:
 * it awaits the underlying durable projection first, then publishes best-effort
 * MCP re-read hints. A signal fan-out failure never fails the durable side
 * effect or the outbox acknowledgement, because hints are non-authoritative.
 * Signals carry only Resource URIs, never event payloads or Resource bodies.
 */
import {
  createPhase4bMcpResourceIdentity,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
  type Phase4bMcpChangeSignalSource,
} from '../../modules/mcp/index.js';
import type {
  CollectionMutationDelivery,
  CollectionMutationProjectionSink,
} from './collection-mutation-events.js';

export interface Phase4bMcpChangeSignalSinkOptions {
  readonly projectionSink: CollectionMutationProjectionSink;
  readonly signalSource: Phase4bMcpChangeSignalSource;
  readonly config: McpReadFeatureConfig;
  readonly onError?: (error: unknown) => void;
  /** Same P4 re-assert options `loadConfig` used; omit for production-strict. */
  readonly assertOptions?: McpReadFeatureConfigAssertOptions;
}

/**
 * Wraps a projection sink so committed Collection/Node mutation deliveries
 * fan out as MCP hints after their durable projection has been applied.
 */
export function createPhase4bMcpChangeSignalSink(
  options: Phase4bMcpChangeSignalSinkOptions,
): CollectionMutationProjectionSink {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('MCP change signal sink options must be an object.');
  }
  const projectionSink = readOwnData(options, 'projectionSink');
  const signalSource = readOwnData(options, 'signalSource');
  const config = readOwnData(options, 'config');
  const onErrorValue = readOptionalOwnData(options, 'onError');
  const onError = onErrorValue === undefined
    ? undefined
    : onErrorValue as (error: unknown) => void;
  if (
    typeof projectionSink !== 'object'
    || projectionSink === null
    || typeof (projectionSink as { apply?: unknown }).apply !== 'function'
  ) {
    throw new TypeError('MCP change signal sink requires a projection sink.');
  }
  if (
    typeof signalSource !== 'object'
    || signalSource === null
    || typeof (signalSource as { publish?: unknown }).publish !== 'function'
  ) {
    throw new TypeError('MCP change signal sink requires a change signal source.');
  }
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('MCP change signal sink requires MCP Read config.');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('MCP change signal sink onError must be a function.');
  }

  const assertOptionsValue = readOptionalOwnData(options, 'assertOptions');
  if (
    assertOptionsValue !== undefined
    && (typeof assertOptionsValue !== 'object' || assertOptionsValue === null
      || Array.isArray(assertOptionsValue))
  ) {
    throw new TypeError('MCP change signal sink assertOptions must be an object.');
  }
  const identity = createPhase4bMcpResourceIdentity(
    config as McpReadFeatureConfig,
    (assertOptionsValue ?? {}) as McpReadFeatureConfigAssertOptions,
  );
  const durableSink = projectionSink as CollectionMutationProjectionSink;
  const source = signalSource as Phase4bMcpChangeSignalSource;

  return Object.freeze({
    durability: durableSink.durability,
    async apply(delivery: CollectionMutationDelivery): Promise<void> {
      await durableSink.apply(delivery);
      try {
        await publishSignals(identity, source, delivery);
      } catch (error) {
        if (onError !== undefined) onError(error);
      }
    },
  });
}

async function publishSignals(
  identity: ReturnType<typeof createPhase4bMcpResourceIdentity>,
  source: Phase4bMcpChangeSignalSource,
  delivery: CollectionMutationDelivery,
): Promise<void> {
  const payload = delivery.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const collectionId = readString(payload, 'collectionId');
  if (collectionId === undefined) return;

  const metadataUri = identity.collectionMetadata(collectionId);
  const snapshotUri = identity.collectionSnapshot(collectionId);
  await source.publish({ type: 'resource-updated', resourceUri: metadataUri });
  await source.publish({ type: 'resource-updated', resourceUri: snapshotUri });
  const nodeId = readString(payload, 'nodeId');
  if (nodeId !== undefined) {
    await source.publish({
      type: 'resource-updated',
      resourceUri: identity.collectionNode(collectionId, nodeId),
    });
  }
  // Do not broadcast a global list invalidation for every private mutation.
  // The signal is observable by anonymous MCP listeners and would turn
  // private edits into a cross-tenant activity side channel. Resource-specific
  // hints above remain scoped to the committed collection/node; list callers
  // revalidate their bounded cache TTL.
}

function readString(value: object, name: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

function readOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('MCP change signal sink options must use own data properties.');
  }
  return descriptor.value;
}

function readOptionalOwnData(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError('MCP change signal sink options must use own data properties.');
  }
  return descriptor.value;
}
