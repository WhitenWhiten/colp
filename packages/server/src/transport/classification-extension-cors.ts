import type { FastifyInstance } from 'fastify';
import { extensionProductAllowedOrigins, type ExtensionProductOriginConfiguration } from './extension-product-origins.js';
export { extensionProductAllowedOrigins as classificationProductAllowedOrigins } from './extension-product-origins.js';

const CREDIT_LEDGER_PATH = /^\/api\/v1\/me\/credits(?:\/ledger(?:\/[^/]+)?)?$/u;

export function isCreditLedgerPath(path: string): boolean {
  return CREDIT_LEDGER_PATH.test(path);
}

export function isTrustedClassificationExtensionOrigin(config: ExtensionProductOriginConfiguration, origin: string): boolean {
  return config.betterAuth.enabled
    && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)
    && config.betterAuth.trustedOrigins.includes(origin);
}

/** Only explicitly listed Product surfaces opt into Extension cookies. */
export function installClassificationExtensionCors(app: FastifyInstance, config: ExtensionProductOriginConfiguration): void {
  const origins = new Set(extensionProductAllowedOrigins(config).filter(origin => origin.startsWith('chrome-extension://')));
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origins.has(origin)) return;
    const path = request.url.split('?', 1)[0]!;
    const creditPath = isCreditLedgerPath(path);
    const subscriptionMethods = bookmarkSubscriptionCorsMethods(path);
    const annotationMethods = /^\/api\/v1\/collections\/[^/]+\/annotations$/u.test(path) ? 'GET, POST, OPTIONS'
      : /^\/api\/v1\/collections\/[^/]+\/annotations\/[^/]+$/u.test(path) ? 'GET, PATCH, DELETE, OPTIONS' : null;
    const methods = annotationMethods ?? subscriptionMethods ?? (path === '/api/v1/me/capture-learning' ? 'GET, OPTIONS'
      : path === '/api/v1/me/capture-learning/clear' ? 'POST, OPTIONS'
      : path === '/api/v1/me/bookmark-captures' ? 'GET, POST, OPTIONS'
      : path === '/api/v1/me/bookmark-captures/aggregate' ? 'GET, OPTIONS'
      : path === '/api/v1/me/capture-capabilities' ? 'GET, OPTIONS'
      : /^\/api\/v1\/collections\/[^/]+\/capture-decisions(?:\/[^/]+(?:\/(?:apply|undo|correct|feedback))?)?$/u.test(path) ? 'GET, POST, OPTIONS'
      : path === '/api/v1/session' ? 'GET, OPTIONS'
      : creditPath ? 'GET, OPTIONS'
      : path === '/api/v1/me/bookmark-preferences' ? 'GET, PATCH, OPTIONS'
      : /^\/api\/v1\/collections\/[^/]+\/editor$/u.test(path) ? 'GET, OPTIONS'
      : /^\/api\/v1\/collections\/[^/]+\/classification-settings$/u.test(path) ? 'GET, PATCH, OPTIONS'
        : /^\/api\/v1\/collections\/[^/]+\/(?:classification\/preview|nodes\/[^/]+\/classification-confirmations)$/u.test(path) ? 'POST, OPTIONS' : null);
    if (!methods) return;
    reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Allow-Credentials', 'true').header('Vary', 'Origin')
      .header('Access-Control-Allow-Headers', creditPath ? 'Content-Type, Origin' : 'Content-Type, Known-Command-Id, X-CSRF-Token, If-Match, If-None-Match, Known-Subscription-Exit-Preview'
        + (annotationMethods ? ', Known-Annotation-Session' : ''))
      .header('Access-Control-Expose-Headers', creditPath ? 'Cache-Control, Retry-After, X-Request-Id' : 'ETag, Cache-Control, Retry-After, X-Request-Id'
        + (subscriptionMethods ? ', Known-Subscription-Session, Known-Bookmark-Session' : '')
        + (annotationMethods ? ', Known-Annotation-Session' : '')
        + (path === '/api/v1/me/bookmark-preferences' ? ', Known-Bookmark-Session' : '')
        + (/\/editor$/u.test(path) ? ', Known-Editor-Session' : '')
        + ((path.startsWith('/api/v1/me/bookmark-captures') || path.startsWith('/api/v1/me/capture-learning') || path.includes('/capture-decisions')) ? ', Known-Capture-Session' : ''))
      .header('Access-Control-Allow-Methods', methods);
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
}

/** Exact subscription route/method allowlist; no prefix wildcard grants. */
export function bookmarkSubscriptionCorsMethods(path: string): string | null {
  if (/^\/api\/v1\/me\/(?:bookmark-subscription-capabilities|bookmark-subscription-sources(?:\/(?:collection|digest_series)\/[^/]+)?|bookmark-subscription-actions|bookmark-subscription-mappings\/[^/]+\/(?:projection|access)|bookmark-subscription-snapshots\/[^/]+\/nodes|report-readers\/[^/]+(?:\/editions\/[^/]+)?)$/.test(path)) return 'GET, OPTIONS';
  if (/^\/api\/v1\/me\/bookmark-subscriptions(?:\/[^/]+\/mappings)?$/.test(path)) return 'GET, POST, OPTIONS';
  if (/^\/api\/v1\/me\/bookmark-subscriptions\/[^/]+$/.test(path) || path === '/api/v1/me/bookmark-subscription-mappings') return 'GET, OPTIONS';
  if (/^\/api\/v1\/me\/bookmark-subscription-mappings\/[^/]+$/.test(path)) return 'GET, PATCH, OPTIONS';
  if (/^\/api\/v1\/me\/(?:bookmark-subscription-snapshots|bookmark-subscription-exit-previews|bookmark-subscription-exits|bookmark-subscription-actions\/[^/]+\/ack|bookmark-subscription-mappings\/[^/]+\/node-access-checks)$/.test(path)) return 'POST, OPTIONS';
  if (/^\/api\/v1\/(?:collections|reports)\/[^/]+\/follow$/.test(path)) return 'GET, PUT, DELETE, OPTIONS';
  return null;
}
