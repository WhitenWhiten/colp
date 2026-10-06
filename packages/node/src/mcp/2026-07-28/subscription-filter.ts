import { types as nodeTypes } from 'node:util';

import { cloneAndFreezeJsonData } from '../../schema/json.js';
import { snapshotBoundedStrings } from '../../security/bounded-string-array.js';
import {
  SubscriptionFilterSchema,
} from '../../shared/mcp-sdk-boundary.js';
import { Mcp20260728RequestError } from './request-context.js';
import type {
  Mcp20260728ListenOptInType,
  Mcp20260728SubscriptionFilter,
} from './subscriptions.js';

type CapabilityCheck = (
  capabilities: Readonly<Record<string, unknown>>,
  type: Mcp20260728ListenOptInType,
) => boolean;

export function validateMcp20260728ListenParams(
  input: unknown,
  capabilities: Readonly<Record<string, unknown>>,
  isSupported: CapabilityCheck,
): Mcp20260728SubscriptionFilter {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || nodeTypes.isProxy(input)) {
    throw invalidParams('subscriptions/listen params');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw invalidParams('subscriptions/listen params');
  const notifications = readOwnValue(input, 'notifications', () => invalidParams('subscriptions/listen params'));
  if (notifications === undefined) throw invalidParams('subscriptions/listen notifications');
  let boundedNotifications: unknown;
  try {
    if (typeof notifications !== 'object' || notifications === null || nodeTypes.isProxy(notifications)) {
      throw new TypeError('Invalid notifications.');
    }
    const subscriptions = readOwnValue(notifications, 'resourceSubscriptions', () => invalidParams('resourceSubscriptions'));
    if (subscriptions !== undefined) {
      snapshotBoundedStrings(subscriptions, 'resourceSubscriptions', {
        maxEntries: 256, maxStringBytes: 2048, maxTotalBytes: 64 * 1024,
      });
    }
    boundedNotifications = cloneAndFreezeJsonData(notifications, {
      maxDepth: 8, maxMembers: 1024, maxBytes: 64 * 1024,
    });
  } catch {
    throw invalidParams('subscriptions/listen notifications budget or data');
  }
  const parsed = SubscriptionFilterSchema.safeParse(boundedNotifications);
  if (!parsed.success) throw invalidParams('subscriptions/listen notifications');
  const data = parsed.data as Mcp20260728SubscriptionFilter;
  const requested: Array<[Mcp20260728ListenOptInType, string]> = [];
  if (data.toolsListChanged === true) requested.push(['toolsListChanged', 'tools.listChanged']);
  if (data.promptsListChanged === true) requested.push(['promptsListChanged', 'prompts.listChanged']);
  if (data.resourcesListChanged === true) requested.push(['resourcesListChanged', 'resources.listChanged']);
  if (data.resourceSubscriptions !== undefined) requested.push(['resourceSubscriptions', 'resources.subscribe']);
  for (const [type, capabilityPath] of requested) {
    if (!isSupported(capabilities, type)) {
      throw invalidParams(`subscriptions/listen notification type ${type} is not supported by the server capabilities (${capabilityPath})`);
    }
  }
  const resourceSubscriptions = data.resourceSubscriptions;
  if (resourceSubscriptions !== undefined) {
    for (const uri of resourceSubscriptions) {
      if (typeof uri !== 'string' || uri.length === 0) throw invalidParams('subscriptions/listen resourceSubscriptions');
    }
  }
  return Object.freeze({
    ...(data.toolsListChanged !== undefined ? { toolsListChanged: data.toolsListChanged } : {}),
    ...(data.promptsListChanged !== undefined ? { promptsListChanged: data.promptsListChanged } : {}),
    ...(data.resourcesListChanged !== undefined ? { resourcesListChanged: data.resourcesListChanged } : {}),
    ...(resourceSubscriptions !== undefined ? { resourceSubscriptions: Object.freeze([...resourceSubscriptions]) } : {}),
  });
}

function invalidParams(message: string): Mcp20260728RequestError {
  return new Mcp20260728RequestError('invalid_params', `Invalid ${message}.`);
}

function readOwnValue(value: object, name: string, fail: () => Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw fail();
  return descriptor.value;
}
