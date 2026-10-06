import { types as nodeTypes } from 'node:util';

import { isHttpUrl } from '../schema/uri.js';
import type { HttpUrl } from '../types/generated.js';

export type McpHttpUriPurpose = 'approval' | 'secret_reveal';

export interface McpHttpUriPolicyInput {
  readonly purpose: McpHttpUriPurpose;
  readonly uri: HttpUrl;
  readonly origin: string;
}

/**
 * Required deployment policy for model-visible HTTP URIs.
 *
 * The protocol permits both HTTP and HTTPS. A remote deployment will usually
 * allow only HTTPS while a local host may explicitly allow HTTP loopback.
 */
export interface McpHttpUriPolicyPort {
  readonly allow: (input: Readonly<McpHttpUriPolicyInput>) => boolean;
}

export type ResolvedMcpHttpUriPolicy = Readonly<{
  receiver: object;
  allow: McpHttpUriPolicyPort['allow'];
}>;

export function resolveMcpHttpUriPolicy(policy: unknown): ResolvedMcpHttpUriPolicy {
  if (typeof policy !== 'object' || policy === null || nodeTypes.isProxy(policy)) {
    throw new TypeError('A non-Proxy own-data uriPolicy port is required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(policy, 'allow');
  if (descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'function'
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError('uriPolicy must own an allow data function.');
  }
  return Object.freeze({
    receiver: policy,
    allow: descriptor.value as McpHttpUriPolicyPort['allow'],
  });
}

/** Parse, normalize, validate against canonical httpUrl, then ask host policy. */
export function authorizeMcpHttpUri(
  candidate: unknown,
  purpose: McpHttpUriPurpose,
  policy: ResolvedMcpHttpUriPolicy,
): HttpUrl {
  if (!isHttpUrl(candidate)) {
    throw new TypeError(`${purpose} URI must satisfy the canonical httpUrl contract.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`${purpose} URI must be parseable as an absolute HTTP(S) URL.`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== '') {
    throw new TypeError(`${purpose} URI must use HTTP(S) without userinfo or a fragment.`);
  }

  const normalized = parsed.href;
  if (!isHttpUrl(normalized)) {
    throw new TypeError(`${purpose} URI normalization failed the canonical httpUrl contract.`);
  }
  const decision = Object.freeze({
    purpose,
    uri: normalized,
    origin: parsed.origin,
  });
  let allowed: unknown;
  try {
    allowed = Reflect.apply(policy.allow, policy.receiver, [decision]);
  } catch {
    throw new TypeError(`${purpose} URI was rejected by host policy.`);
  }
  if (allowed !== true) {
    throw new TypeError(`${purpose} URI was rejected by host policy.`);
  }
  return normalized;
}
