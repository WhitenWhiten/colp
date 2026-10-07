import type { FastifyInstance } from 'fastify';
import { PRODUCT_ROUTE_MANIFEST } from '../../generated/openapi/product-v1.routes.js';
import { AUTH_ROUTE_MANIFEST } from './auth/auth-route-manifest.js';

export type ProductRouteManifestEntry = (typeof PRODUCT_ROUTE_MANIFEST)[number];

/**
 * F2: the legacy OIDC manifest operationIds (derived from the single
 * auth-route manifest). Better Auth mode composes zero legacy OIDC routes
 * while the OpenAPI keeps the operations marked deprecated (rollback-safe),
 * so the coverage assertion must skip them in BA mode. Legacy mode keeps
 * requiring them. F3 removes the entries entirely.
 */
export const LEGACY_OIDC_OPERATION_IDS: readonly string[] = Object.freeze(
  AUTH_ROUTE_MANIFEST
    .filter((entry) => entry.scope === 'legacy-oidc')
    .map((entry) => entry.operationId),
);

/**
 * BF-02: favicon GET is registered when a store is composed. POST/DELETE are
 * registered by BF-03 even when the store is absent (503 fail-closed).
 */
export const BOOKMARK_FAVICON_DEFERRED_OPERATION_IDS: readonly string[] = Object.freeze([]);

/**
 * D4: the server-BYOK provider-profile operations are hard-gated. With
 * `KNOWN_FEATURE_CLASSIFICATION_BYOK=false` their routes are not registered at
 * all, so the readiness coverage assertion must stop requiring them while the
 * gate is off. This is the route-manifest projection of the plan's
 * `x-known-feature-gate: classification_byok` annotation, derived from the
 * generated manifest so a new profile operation is covered automatically.
 */
export const CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX = '/api/v1/me/classification-provider-profiles';
export const CLASSIFICATION_BYOK_OPERATION_IDS: readonly string[] = Object.freeze(
  PRODUCT_ROUTE_MANIFEST
    .filter((entry) => entry.path === CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX
      || entry.path.startsWith(`${CLASSIFICATION_BYOK_PROFILE_PATH_PREFIX}/`))
    .map((entry) => entry.operationId),
);

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${openApiPath(path)}`;
}

export function assertProductRouteCoverage(
  registered: ReadonlySet<string>,
  excludeOperationIds: readonly string[] = [],
): void {
  const expected = PRODUCT_ROUTE_MANIFEST
    .filter((item) => !excludeOperationIds.includes(item.operationId))
    .map((item) => `${item.method} ${item.path}`);
  const missing = expected.filter((item) => !registered.has(item));
  if (missing.length > 0) {
    throw new Error(`Product routes missing from registration: ${missing.join(', ')}`);
  }
}

export interface ProductRouteManifestCheckOptions {
  readonly requireComplete: boolean;
  /**
   * F2: operationIds excluded from the coverage assertion (the legacy OIDC
   * entries in Better Auth mode — the OpenAPI keeps them deprecated until
   * F3 removes them).
   */
  readonly excludeOperationIds?: readonly string[];
  /**
   * D4: whether the server-BYOK gate is on. When it is not, the five
   * provider-profile routes are deliberately absent from the route table, so
   * their operations must leave the coverage requirement with them — otherwise a
   * complete composition fails readiness on the default
   * `KNOWN_FEATURE_CLASSIFICATION_BYOK=false`.
   */
  readonly classificationByokEnabled?: boolean;
}

export function installProductRouteManifestChecks(
  app: FastifyInstance,
  options: ProductRouteManifestCheckOptions,
): void {
  const registered = new Set<string>();
  const featureGatedExclusions = options.classificationByokEnabled === true ? [] : CLASSIFICATION_BYOK_OPERATION_IDS;
  let pendingImplicitHead: string | undefined;
  app.addHook('onRoute', (route) => {
    const operationId = (route.config as { productOperationId?: unknown } | undefined)?.productOperationId;
    if (typeof operationId !== 'string') return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const normalizedMethods = methods.map((method) => String(method).toUpperCase());
    const routeIdentity = `${openApiPath(route.url)}\u0000${operationId}`;
    if (
      normalizedMethods.length === 1
      && normalizedMethods[0] === 'HEAD'
      && pendingImplicitHead === routeIdentity
    ) {
      pendingImplicitHead = undefined;
      return;
    }
    pendingImplicitHead = undefined;
    for (const method of normalizedMethods) {
      const entry = PRODUCT_ROUTE_MANIFEST.find((item) => item.method === method && item.path === openApiPath(route.url));
      if (!entry || entry.operationId !== operationId) {
        throw new Error(`Product route is not in the OpenAPI manifest: ${method} ${route.url} (${operationId})`);
      }
      registered.add(key(method, route.url));
    }
    if (
      normalizedMethods.length === 1
      && normalizedMethods[0] === 'GET'
      && (route.exposeHeadRoute
        ?? (app.initialConfig as { readonly exposeHeadRoutes?: boolean }).exposeHeadRoutes
        ?? true)
    ) {
      pendingImplicitHead = routeIdentity;
    }
  });
  app.addHook('onReady', async () => {
    if (!options.requireComplete) return;
    assertProductRouteCoverage(registered, [...(options.excludeOperationIds ?? []), ...featureGatedExclusions]);
  });
}

export function productRouteMetadata(
  method: ProductRouteManifestEntry['method'],
  path: string,
): { readonly productOperationId: ProductRouteManifestEntry['operationId'] } {
  const normalizedPath = openApiPath(path);
  const entry = PRODUCT_ROUTE_MANIFEST.find((item) =>
    item.method === method && item.path === normalizedPath);
  if (!entry) throw new Error(`Product route is not in the OpenAPI manifest: ${method} ${path}`);
  return { productOperationId: entry.operationId };
}
