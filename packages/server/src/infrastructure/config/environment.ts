/**
 * Process-environment facts shared by the API/worker config, the migration CLI
 * and the seed CLI. Both parsers normalize/validate once, before any feature
 * loader runs, so a typo cannot silently select development defaults.
 */

/** Closed set of deployment environments (`NODE_ENV`). */
export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Loopback default: the API never listens on every interface implicitly. */
export const DEFAULT_LISTEN_HOST = '127.0.0.1';

export function isNodeEnvironment(value: string): value is NodeEnvironment {
  return (NODE_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Normalize `NODE_ENV` (trim + lowercase) and reject values outside the closed
 * set. A blank/whitespace-only value is treated as unset and keeps the
 * historical `development` default.
 */
export function loadNodeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeEnvironment {
  const normalized = env.NODE_ENV?.trim().toLowerCase() ?? '';
  if (normalized === '') return 'development';
  if (!isNodeEnvironment(normalized)) {
    throw new Error(
      `NODE_ENV must be one of ${NODE_ENVIRONMENTS.join(', ')}; received ${JSON.stringify(env.NODE_ENV)}`,
    );
  }
  return normalized;
}

/**
 * Resolve the API listener host from `HOST`.
 *
 * An explicit empty/whitespace-only value is treated as unset instead of being
 * passed to `listen()`, where `''` binds all interfaces. Only a non-empty value
 * can widen the bind address.
 */
export function loadListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.HOST?.trim();
  return host === undefined || host === '' ? DEFAULT_LISTEN_HOST : host;
}
