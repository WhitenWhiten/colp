import { types as nodeTypes } from 'node:util';
import type {
  McpChangePlanRateLimitPort,
} from './change-plan.js';
import type { McpAuthenticatedAuthorizationBinding } from './shared/authorization.js';

export type ReadChangePlanPort = (
  options: object,
  name: string,
  methods: readonly string[],
) => { receiver: object; [method: string]: unknown };

export function readChangePlanRateLimitPort(
  options: object,
  readPort: ReadChangePlanPort,
): {
  receiver: object;
  allow: McpChangePlanRateLimitPort['allow'];
  allowPlan?: McpChangePlanRateLimitPort['allowPlan'];
} {
  const required = readPort(options, 'rateLimit', ['allow']);
  const allowPlan = Object.getOwnPropertyDescriptor(required.receiver, 'allowPlan');
  if (allowPlan === undefined) return required as {
    receiver: object;
    allow: McpChangePlanRateLimitPort['allow'];
  };
  if (!('value' in allowPlan) || typeof allowPlan.value !== 'function' || nodeTypes.isProxy(allowPlan.value)) {
    throw new TypeError('The rateLimit port allowPlan must be a non-Proxy data function when provided.');
  }
  return Object.freeze({
    receiver: required.receiver,
    allow: required.allow as McpChangePlanRateLimitPort['allow'],
    allowPlan: allowPlan.value as McpChangePlanRateLimitPort['allowPlan'],
  });
}

export async function allowChangePlanAdmission(
  rateLimit: {
    readonly receiver: object;
    readonly allow: McpChangePlanRateLimitPort['allow'];
    readonly allowPlan?: McpChangePlanRateLimitPort['allowPlan'];
  },
  binding: McpAuthenticatedAuthorizationBinding,
): Promise<boolean> {
  const input = rateLimit.allowPlan === undefined
    ? { planId: '__plan_admission__', binding }
    : { binding };
  const method = rateLimit.allowPlan ?? rateLimit.allow;
  return await Reflect.apply(method, rateLimit.receiver, [Object.freeze(input)]);
}
