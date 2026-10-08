import { randomUUID } from 'node:crypto';
import Fastify, { type HTTPMethods } from 'fastify';
import { DatabaseOperationError } from '../infrastructure/database/errors.js';
import { applySecurityHeaders } from './http-security.js';
import { mapProductDatabaseError } from './product-command-mapping.js';
import { ProductHttpError, type ProductErrorEnvelope } from './product-error.js';

const BOOKMARK_FAVICON_HELPER_PATH =
  /^\/colp\/v0\.1\/sync\/collections\/([A-Za-z0-9._~-]{1,128})\/nodes\/([A-Za-z0-9._~-]{1,128})\/favicon(?:-source)?$/u;
const EXTENSION_FAVICON_POLICY_PATH = '/colp/v0.1/sync/favicon-policy';

/**
 * FO-04 helper surface paths under /colp/v0.1/sync: capture/clear favicon
 * (legacy path), the per-node favicon-source read and the account
 * favicon-policy read. These are Product-envelope helper operations, not the
 * strict COLP protocol, so they never route through Publication framing.
 */
export function matchesBookmarkFaviconHelperPath(requestPath: string): boolean {
  return requestPath === EXTENSION_FAVICON_POLICY_PATH
    || BOOKMARK_FAVICON_HELPER_PATH.test(requestPath);
}

export function isPublicationUrl(url: string): boolean {
  const path = url.split('?', 1)[0];
  // Known-owned favicon helper is a Product command surface, not COLP.
  if (path !== undefined && matchesBookmarkFaviconHelperPath(path)) return false;
  return path?.startsWith('/colp/') === true || path === '/.well-known/collection-protocol';
}

export function isPublicReportUrl(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/reports' || path.startsWith('/reports/');
}

/**
 * FIX-L-004: every /api/v1/** request is part of the Product surface. A
 * malformed URL (bad percent-encoding in the path) must produce the same
 * fixed invalid_request Product envelope everywhere instead of the Fastify
 * default shape, which echoed the encoded path and lacked request id,
 * no-store and security headers.
 */
export function isProductUrl(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/api/v1' || path.startsWith('/api/v1/');
}

export function isMalformedUrlError(error: unknown): boolean {
  if (error instanceof URIError) return true;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === 'FST_ERR_BAD_URL';
}


const NON_PRODUCT_BAD_URL_MESSAGE = 'The request URL is not a valid url component';

export function sendBadUrlProductError(
  path: string,
  response: import('node:http').ServerResponse,
  options: { readonly enableHsts: boolean },
): void {
  // onBadUrl bypasses onRequest/onSend, so every surface must apply the
  // security baseline and no-store here (FIX-L-004 / SEC-T-07).
  applySecurityHeaders(
    { header: (name, value) => response.setHeader(name, value) },
    { enableHsts: options.enableHsts },
  );
  response.setHeader('Cache-Control', 'private, no-store');

  if (isProductUrl(path)) {
    // FIX-L-004: unified fixed invalid_request Product Problem for every
    // /api/v1/** bad URL. The malformed URL is never reflected (it may carry
    // raw undecodable bytes) and the response carries the same request id,
    // no-store policy and security headers as any Product error.
    const requestId = randomUUID();
    const payload: ProductErrorEnvelope = {
      error: {
        code: 'invalid_request',
        message: 'The request URL is invalid.',
        requestId,
        recovery: 'user_action',
        sameRequestRetrySafe: false,
        precondition: null,
        currentEtag: null,
        retryAfterSeconds: null,
        fieldErrors: [],
      },
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    response.setHeader('X-Request-Id', requestId);
    response.writeHead(400, {
      'Content-Length': String(body.byteLength),
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(body);
    return;
  }
  if (isPublicReportUrl(path)) {
    const body = Buffer.from('<!doctype html><html><head><title>Bad request — Know-N</title></head><body><h1>Bad request</h1></body></html>', 'utf8');
    response.writeHead(400, { 'Content-Length': String(body.byteLength), 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); return;
  }
  // COLP / MCP / other surfaces keep the Fastify-shaped envelope but never
  // interpolate the malformed path (it may carry raw undecodable bytes).
  const body = Buffer.from(JSON.stringify({
    error: 'Bad Request',
    code: 'FST_ERR_BAD_URL',
    message: NON_PRODUCT_BAD_URL_MESSAGE,
    statusCode: 400,
  }), 'utf8');
  response.writeHead(400, {
    'Content-Length': String(body.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

const METHODS: readonly HTTPMethods[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export function allowedMethods(app: ReturnType<typeof Fastify>, rawUrl: string): HTTPMethods[] {
  const url = rawUrl.split('?', 1)[0] ?? rawUrl;
  return METHODS.filter((method) => app.findRoute({ method, url }) !== null);
}

export function mapFrameworkError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof DatabaseOperationError) return mapProductDatabaseError(error);
  const frameworkCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  // Reports application errors are intentionally mapped by code here to keep
  // the transport boundary independent from the reports module facade.
  if (typeof frameworkCode === 'string' && [
    'resource_not_found', 'forbidden', 'precondition_failed', 'conflict', 'invalid_request',
    // Reports domain errors are deliberately mapped by their stable code at
    // the transport boundary.  Their messages may contain validation detail,
    // so use the fixed Product message below rather than reflecting them.
    'invalid_input', 'invalid_transition', 'source_rebind_forbidden', 'self_follow_forbidden',
    'lease_conflict', 'dependency_unavailable',
  ].includes(frameworkCode)) {
    const mapping = frameworkCode === 'resource_not_found' ? { statusCode: 404, code: 'resource_not_found' as const, recovery: 'none' as const }
      : frameworkCode === 'forbidden' ? { statusCode: 403, code: 'insufficient_permission' as const, recovery: 'none' as const }
      : frameworkCode === 'precondition_failed' ? { statusCode: 412, code: 'precondition_failed' as const, recovery: 'refresh_and_retry' as const }
      : frameworkCode === 'dependency_unavailable'
        ? { statusCode: 503, code: 'feature_temporarily_unavailable' as const, recovery: 'same_request' as const }
      : frameworkCode === 'conflict' || frameworkCode === 'lease_conflict' || frameworkCode === 'invalid_transition'
        ? { statusCode: 409, code: 'mutation_conflict' as const, recovery: 'user_action' as const }
      : { statusCode: 400, code: 'invalid_request' as const, recovery: 'user_action' as const };
    return new ProductHttpError({ ...mapping, message: 'The report request could not be completed.' });
  }
  if (frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new ProductHttpError({ statusCode: 413, code: 'payload_too_large', message: 'The request body is too large.' });
  }
  if (frameworkCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new ProductHttpError({ statusCode: 415, code: 'unsupported_media_type', message: 'This media type is not supported.' });
  }
  if (frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || frameworkCode === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new ProductHttpError({ statusCode: 400, code: 'invalid_json', message: 'The JSON body is invalid.' });
  }
  return new ProductHttpError({
    statusCode: 500,
    code: 'internal_error',
    message: 'The request could not be completed.',
    recovery: 'same_request',
  });
}
