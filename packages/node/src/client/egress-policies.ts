import type { ClientEgressPolicy } from './index.js';

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An egress policy for local development and tests: it allows requests to the
 * listed loopback origins and denies every other destination.
 *
 * Without a policy, `ColpClient` reaches a loopback server only on the first
 * hop to the `manifestUrl` origin, so redirects and the `next` links of a paged
 * Snapshot are refused. This policy allows those too, without the blanket
 * `() => true` that would also disable the client's protection against
 * requests to private networks.
 *
 * @throws RangeError when the list is empty or names a host other than
 *   `localhost`, `127.0.0.1`, or `[::1]`.
 */
export function createLoopbackEgressPolicy(origins: readonly (string | URL)[]): ClientEgressPolicy {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new RangeError('Loopback egress policy needs at least one origin.');
  }
  const allowed = new Set<string>();
  for (const origin of origins) {
    const url = new URL(origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopbackHostnames.has(url.hostname)) {
      throw new RangeError(`Loopback egress policy accepts only http(s) loopback origins, not ${url.origin}.`);
    }
    allowed.add(url.origin);
  }
  return (url) => allowed.has(url.origin);
}
