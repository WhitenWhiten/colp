import type { BuildConfig, Environment } from './types.js';
import { isLoopbackHttpHost } from './http-origin.js';

export const RUNTIME_ORIGIN_KEY = 'runtimeServerOrigin';

/**
 * Semver MINOR values of `features.edition.version` this extension supports.
 * The Account tab notices a server whose minor is older than these.
 */
export const SUPPORTED_SERVER_MINORS: readonly number[] = Object.freeze([1, 2]);

const SERVER_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:[-+][0-9A-Za-z.-]+)?$/u;

/**
 * True when `version` is older than {@link SUPPORTED_SERVER_MINORS}.
 * Comparison uses the minor on the 0.x line. A higher major is a newer server.
 */
export function isOlderThanSupportedServerMinor(version: string): boolean {
  const match = SERVER_VERSION.exec(version.trim());
  const floor = SUPPORTED_SERVER_MINORS.reduce<number | undefined>((lowest, value) => (
    lowest === undefined || value < lowest ? value : lowest
  ), undefined);
  if (!match || floor === undefined) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 0) return false;
  return minor < floor;
}

const RELEASE_EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const ALGORITHMS = new Set(['RS256', 'PS256', 'ES256', 'ES384']);
const PINNED = Object.freeze({
  development: Object.freeze({ serverOrigin: 'http://127.0.0.1:4173', manifestUrl: 'http://127.0.0.1:4173/.well-known/collection-protocol',
    issuer: 'http://127.0.0.1:4173/', authorizationEndpoint: 'http://127.0.0.1:4173/api/v1/auth/sign-in/email',
    tokenEndpoint: 'http://127.0.0.1:4173/api/v1/auth/get-session', jwksUri: 'http://127.0.0.1:4173/.well-known/jwks.json',
    revocationEndpoint: 'http://127.0.0.1:4173/api/v1/auth/sign-out' }),
  staging: Object.freeze({ serverOrigin: 'https://staging.known.example', manifestUrl: 'https://staging.known.example/.well-known/collection-protocol',
    issuer: 'https://staging.known.example/', authorizationEndpoint: 'https://staging.known.example/api/v1/auth/sign-in/email',
    tokenEndpoint: 'https://staging.known.example/api/v1/auth/get-session', jwksUri: 'https://staging.known.example/.well-known/jwks.json',
    revocationEndpoint: 'https://staging.known.example/api/v1/auth/sign-out' }),
  production: Object.freeze({ serverOrigin: 'https://known.example', manifestUrl: 'https://known.example/.well-known/collection-protocol',
    issuer: 'https://known.example/', authorizationEndpoint: 'https://known.example/api/v1/auth/sign-in/email',
    tokenEndpoint: 'https://known.example/api/v1/auth/get-session', jwksUri: 'https://known.example/.well-known/jwks.json',
    revocationEndpoint: 'https://known.example/api/v1/auth/sign-out' }),
});

export function parseBuildConfig(input: unknown): BuildConfig {
  if (!record(input)) throw new TypeError('Extension build config must be an object');
  const known = new Set(['environment', 'deploymentId', 'extensionId', 'serverOrigin', 'manifestUrl', 'issuer',
    'authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'revocationEndpoint', 'clientId', 'audience',
    'scopes', 'allowedAlgorithms', 'refreshBeforeExpirySeconds', 'subscriptionBridgeOrigins']);
  if (Object.keys(input).some((key) => !known.has(key))) throw new TypeError('Unknown public-client setting');
  const environment = oneOf(input.environment, ['development', 'staging', 'production']) as Environment;
  const deploymentId = input.deploymentId === undefined ? undefined : string(input.deploymentId);
  if (deploymentId !== undefined && (environment !== 'production' || !/^[a-z0-9][a-z0-9.-]{2,63}$/u.test(deploymentId))) {
    throw new TypeError('Production deployment identifier is invalid');
  }
  const extensionId = string(input.extensionId);
  if (extensionId !== RELEASE_EXTENSION_ID) throw new TypeError('Invalid Chromium extension ID');
  const serverOrigin = exactOrigin(string(input.serverOrigin), environment, deploymentId !== undefined);
  const bridgeInput = input.subscriptionBridgeOrigins ?? [];
  if (!Array.isArray(bridgeInput) || bridgeInput.length > 16) throw new TypeError('Invalid subscription bridge origins');
  const seen = new Set<string>();
  const subscriptionBridgeOrigins = bridgeInput.map((entry: unknown) => {
    if (!record(entry) || Object.keys(entry).some(key => !['webOrigin', 'serverOrigin'].includes(key))) throw new TypeError('Invalid subscription bridge entry');
    const webOrigin = exactOrigin(string(entry.webOrigin), environment, deploymentId !== undefined);
    if (webOrigin.includes('*') || webOrigin !== entry.webOrigin || entry.serverOrigin !== serverOrigin || seen.has(webOrigin)) throw new TypeError('Subscription bridge environment mismatch');
    seen.add(webOrigin);
    return Object.freeze({ webOrigin, serverOrigin });
  });
  const manifestUrl = endpoint(string(input.manifestUrl), environment, false, deploymentId !== undefined);
  const issuer = endpoint(string(input.issuer), environment, true, deploymentId !== undefined);
  const authorizationEndpoint = endpoint(string(input.authorizationEndpoint), environment, false, deploymentId !== undefined);
  const tokenEndpoint = endpoint(string(input.tokenEndpoint), environment, false, deploymentId !== undefined);
  const jwksUri = endpoint(string(input.jwksUri), environment, false, deploymentId !== undefined);
  const revocationEndpoint = endpoint(string(input.revocationEndpoint), environment, false, deploymentId !== undefined);
  if (new URL(manifestUrl).origin !== serverOrigin) throw new TypeError('Manifest must use the pinned server origin');
  for (const candidate of [authorizationEndpoint, tokenEndpoint, jwksUri, revocationEndpoint]) {
    if (new URL(candidate).origin !== new URL(issuer).origin) throw new TypeError('OAuth endpoints must be issuer-origin');
  }
  const scopes = strings(input.scopes);
  if (!['openid', 'offline_access', 'known.sync'].every((scope) => scopes.includes(scope))) {
    throw new TypeError('Required extension scopes are missing');
  }
  const allowedAlgorithms = strings(input.allowedAlgorithms);
  if (allowedAlgorithms.length === 0 || allowedAlgorithms.some((value) => !ALGORITHMS.has(value))) {
    throw new TypeError('OAuth algorithm allowlist is invalid');
  }
  const refreshBeforeExpirySeconds = input.refreshBeforeExpirySeconds;
  if (!Number.isSafeInteger(refreshBeforeExpirySeconds) || Number(refreshBeforeExpirySeconds) < 30
      || Number(refreshBeforeExpirySeconds) > 300) throw new TypeError('Refresh window is invalid');
  const pinned = PINNED[environment];
  const urls = { serverOrigin, manifestUrl, issuer, authorizationEndpoint, tokenEndpoint, jwksUri, revocationEndpoint };
  if ((deploymentId === undefined && Object.entries(pinned).some(([key, value]) => urls[key as keyof typeof urls] !== value))
      || (deploymentId === undefined && (input.clientId !== 'known-chromium-extension' || input.audience !== 'known-sync-api'))
      || scopes.length !== 3 || !['openid', 'offline_access', 'known.sync'].every((scope) => scopes.includes(scope))
      || allowedAlgorithms.length !== 1 || allowedAlgorithms[0] !== 'RS256'
      || refreshBeforeExpirySeconds !== 60) throw new TypeError('Environment configuration is not pinned');
  return Object.freeze({ environment, ...(deploymentId ? { deploymentId } : {}), extensionId, subscriptionBridgeOrigins: Object.freeze(subscriptionBridgeOrigins), serverOrigin, manifestUrl, issuer,
    authorizationEndpoint, tokenEndpoint, jwksUri, revocationEndpoint, clientId: string(input.clientId),
    audience: string(input.audience), scopes: Object.freeze([...new Set(scopes)]),
    allowedAlgorithms: Object.freeze([...new Set(allowedAlgorithms)]),
    refreshBeforeExpirySeconds: Number(refreshBeforeExpirySeconds) });
}

/** Rewrite pinned URLs onto one runtime origin. Does not go through parseBuildConfig, which rejects anything but the build pin. */
export function resolveRuntimeConfig(build: BuildConfig, override?: string): BuildConfig {
  if (override === undefined || override === '') return build;
  let url: URL;
  try { url = new URL(override); } catch { throw new TypeError('Server origin must be exact'); }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Server origin must be exact');
  }
  // A saved runtime origin may be plain HTTP. The options page confirms it first.
  secure(url, build.environment, false, true);
  const origin = url.origin;
  return Object.freeze({
    ...build,
    serverOrigin: origin,
    manifestUrl: origin + '/.well-known/collection-protocol',
    issuer: origin + '/',
    authorizationEndpoint: origin + '/api/v1/auth/sign-in/email',
    tokenEndpoint: origin + '/api/v1/auth/get-session',
    jwksUri: origin + '/.well-known/jwks.json',
    revocationEndpoint: origin + '/api/v1/auth/sign-out',
  });
}

function exactOrigin(value: string, environment: Environment, deploymentOverride = false): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Server origin must be exact');
  }
  secure(url, environment, deploymentOverride);
  return url.origin;
}
function endpoint(value: string, environment: Environment, allowRoot = false, deploymentOverride = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (!allowRoot && url.pathname === '/')) throw new TypeError('Endpoint URL is invalid');
  secure(url, environment, deploymentOverride);
  return url.toString();
}
function secure(url: URL, environment: Environment, deploymentOverride = false, runtimeOrigin = false): void {
  const localDev = environment === 'development' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('HTTPS is required');
  // Build pins stay HTTPS except development loopback. A runtime origin may be
  // HTTP only on loopback, as COLP allows (D26); the options page confirms it first.
  if (url.protocol === 'http:' && !localDev && !(runtimeOrigin && isLoopbackHttpHost(url.hostname))) {
    throw new TypeError('HTTPS is required');
  }
  if (environment === 'production' && !deploymentOverride && !runtimeOrigin
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) throw new TypeError('Local production origin is forbidden');
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function string(value: unknown): string { if (typeof value !== 'string' || value.length === 0) throw new TypeError('Expected string'); return value; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError('Expected string array'); return value; }
function oneOf(value: unknown, allowed: readonly string[]): string { const result = string(value); if (!allowed.includes(result)) throw new TypeError('Unexpected value'); return result; }
