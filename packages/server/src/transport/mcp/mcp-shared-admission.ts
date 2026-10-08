/**
 * Protocol-agnostic MCP HTTP admission helpers shared by the strict
 * `/collections/-/mcp` route and the compatibility `/collections/-/mcp-compat`
 * adapter. Keep rate-limit subject facts identical so switching endpoints
 * cannot mint a second quota.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { McpAuthorizationBinding } from '@know-n/colp/mcp';
import type { McpRateLimitSubject } from '../../infrastructure/rate-limit/index.js';
import { McpOauthVerificationError, type McpReadFeatureConfig } from '../../modules/mcp/index.js';
import { isMcpAudienceForEndpoint, mcpQuotaResource } from './mcp-endpoint-audience.js';
import { productErrorStatus } from '../product-codes.js';
import { ProductHttpError } from '../product-error.js';

export interface McpConnectionBudget {
  acquire(signal: AbortSignal): Promise<boolean>;
  release(): void;
  snapshot(): { readonly active: number; readonly queued: number };
}

interface QueueEntry {
  readonly signal: AbortSignal;
  readonly resolve: (ok: boolean) => void;
  readonly cleanup: () => void;
}

export function createConnectionBudget(
  maxConcurrent: number,
  maxQueue: number,
): McpConnectionBudget {
  let active = 0;
  const waiters: QueueEntry[] = [];

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(false);
      if (active < maxConcurrent) {
        active += 1;
        return Promise.resolve(true);
      }
      if (waiters.length >= maxQueue) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const entry: QueueEntry = {
          signal,
          resolve(ok) {
            if (settled) return;
            settled = true;
            entry.cleanup();
            if (ok) active += 1;
            resolve(ok);
          },
          cleanup() {
            signal.removeEventListener('abort', onAbort);
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
          },
        };
        const onAbort = (): void => entry.resolve(false);
        waiters.push(entry);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    release() {
      active = Math.max(0, active - 1);
      waiters.shift()?.resolve(true);
    },
    snapshot() {
      return Object.freeze({ active, queued: waiters.length });
    },
  };
}

export function headerBudgetViolation(
  pairs: ReadonlyArray<readonly [string, string]>,
  limits: McpReadFeatureConfig['budgets']['request'],
): { readonly code: string } | undefined {
  if (pairs.length > limits.maxHeaderCount) {
    return { code: 'mcp_header_count_exceeded' };
  }
  for (const [name, value] of pairs) {
    if (Buffer.byteLength(name, 'utf8') > limits.maxHeaderNameBytes) {
      return { code: 'mcp_header_name_too_long' };
    }
    if (Buffer.byteLength(value, 'utf8') > limits.maxHeaderValueBytes) {
      return { code: 'mcp_header_value_too_long' };
    }
  }
  return undefined;
}

export function readMcpHeaderPairs(request: FastifyRequest): ReadonlyArray<readonly [string, string]> {
  if (Array.isArray(request.rawHeaderPairs)) return request.rawHeaderPairs;
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    pairs.push([request.raw.rawHeaders[index] ?? '', request.raw.rawHeaders[index + 1] ?? '']);
  }
  return Object.freeze(pairs);
}

/**
 * Both transports call this after OAuth verification and before quota admission
 * or application dispatch. A verifier may know both configured resources, but
 * its selected authenticated binding must belong to this registered endpoint.
 */
export function mcpRateLimitSubject(
  request: FastifyRequest,
  binding: McpAuthorizationBinding,
  /** Trusted configured MCP origin; never derive this from request Host headers. */
  registeredOrigin: string,
): McpRateLimitSubject {
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  if (binding.kind === 'authenticated') {
    if (!isMcpAudienceForEndpoint(binding.resourceAudience, request.routeOptions?.url, registeredOrigin)) {
      throw new McpOauthVerificationError('wrong_audience');
    }
    return {
      policy: 'request',
      facts: [
        'authenticated',
        binding.principalId,
        binding.clientId,
        mcpQuotaResource(binding.resourceAudience),
        binding.securityEpoch,
      ].join(':'),
    };
  }
  return {
    policy: 'request',
    facts: [
      'anonymous',
      mcpQuotaResource(binding.resourceAudience),
      binding.securityEpoch,
      ip,
    ].join(':'),
  };
}

export function singleMcpHeader(
  pairs: ReadonlyArray<readonly [string, string]>,
  name: string,
): string | undefined {
  const values = pairs
    .filter(([fieldName]) => fieldName.toLowerCase() === name)
    .map(([, value]) => value);
  if (values.length === 0) return undefined;
  return values.join(',');
}

/** Stable fail-closed Host admission message; never echo the request Host. */
export const MCP_HOST_INVALID_MESSAGE = 'The Host header is invalid.';

export interface McpTrustedHostAuthority {
  readonly scheme: 'http:' | 'https:';
  readonly hostname: string;
  readonly port: string;
}

const ILLEGAL_HOST_CHARS = /[\u0000-\u0020\u007f/@?#\\,]/u;

function defaultPortForScheme(scheme: 'http:' | 'https:'): string {
  return scheme === 'https:' ? '443' : '80';
}

function hostAuthorityFromAbsoluteUrl(raw: string): McpTrustedHostAuthority {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('MCP origin/endpoint must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('MCP origin/endpoint must use http or https');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) {
    throw new TypeError('MCP origin/endpoint host is missing');
  }
  const port = url.port === '' ? defaultPortForScheme(url.protocol) : url.port;
  if (port === '0') {
    throw new TypeError('MCP origin/endpoint port is invalid');
  }
  return Object.freeze({
    scheme: url.protocol,
    hostname,
    port,
  });
}

/**
 * Exact host+port allowlist derived from the trusted MCP origin/endpoint.
 * Never uses suffix matching. Callers must not consult X-Forwarded-Host.
 */
export function mcpTrustedHostAuthority(
  config: Pick<McpReadFeatureConfig, 'origin' | 'endpoint'>,
): McpTrustedHostAuthority {
  const fromOrigin = hostAuthorityFromAbsoluteUrl(config.origin);
  const fromEndpoint = hostAuthorityFromAbsoluteUrl(config.endpoint);
  if (
    fromOrigin.scheme !== fromEndpoint.scheme
    || fromOrigin.hostname !== fromEndpoint.hostname
    || fromOrigin.port !== fromEndpoint.port
  ) {
    throw new TypeError('MCP origin and endpoint must share one host authority');
  }
  return fromOrigin;
}

/** Host header value that matches the trusted origin (brackets, omit default port). */
export function mcpTrustedRequestHostHeader(origin: string): string {
  return new URL(origin).host;
}

function parseMcpRequestHost(
  value: string,
  scheme: 'http:' | 'https:',
): McpTrustedHostAuthority | undefined {
  if (value.length === 0 || value.endsWith(':') || ILLEGAL_HOST_CHARS.test(value)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`${scheme}//${value}`);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) return undefined;
  if (url.port === '0') return undefined;
  const port = url.port === '' ? defaultPortForScheme(scheme) : url.port;
  return Object.freeze({ scheme, hostname, port });
}

function mcpInvalidHostError(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: MCP_HOST_INVALID_MESSAGE,
    recovery: 'user_action',
    headers: {
      'Cache-Control': 'no-store',
      'Vary': 'Authorization, Origin',
    },
  });
}

/**
 * Shared strict/compat Host allowlist. Ignores X-Forwarded-Host. Exact
 * hostname+port after case and default-port normalization.
 */
export function admitMcpHost(
  pairs: ReadonlyArray<readonly [string, string]>,
  trusted: McpTrustedHostAuthority,
): void {
  const values = pairs
    .filter(([name]) => name.toLowerCase() === 'host')
    .map(([, value]) => value);
  if (values.length !== 1) {
    throw mcpInvalidHostError();
  }
  const parsed = parseMcpRequestHost(values[0]!, trusted.scheme);
  if (
    parsed === undefined
    || parsed.hostname !== trusted.hostname
    || parsed.port !== trusted.port
  ) {
    throw mcpInvalidHostError();
  }
}

export function applyMcpSecurityHeaders(
  reply: FastifyReply,
  requestId: string,
  allowedOrigin: string | undefined,
): void {
  reply.header('X-Request-Id', requestId);
  reply.header('Cache-Control', 'no-store');
  reply.header('Vary', 'Authorization, Origin');
  if (allowedOrigin !== undefined) {
    reply.header('Access-Control-Allow-Origin', allowedOrigin);
    reply.header('Access-Control-Expose-Headers', 'X-Request-Id');
  }
}
