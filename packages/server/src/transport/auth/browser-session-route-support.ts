/**
 * GET /api/v1/session origin admission + DELETE /api/v1/session logout
 * lineage helpers (extracted to keep `browser-auth-handlers.ts` under its
 * source-size ratchet).
 */
import type { FastifyRequest } from 'fastify';
import type { BrowserSessionAuthority } from '../../modules/auth/index.js';
import {
  extensionProductAllowedOrigins,
  type ExtensionProductOriginConfiguration,
} from '../extension-product-origins.js';
import { requireAllowedOrigin } from './origin-csrf.js';

/**
 * Admit the GET /api/v1/session request's Origin and report whether it may
 * authorize rotation.
 *
 * Session bootstrap is a stateful operation when it rotates a mature cookie.
 * A top-level cross-site navigation may carry SameSite=Lax cookies but has no
 * CSRF proof, so only an exact product Origin may authorize rotation. The MV3
 * extension origins are admitted for the read only (the extension CORS
 * allowlist grants this exact path); same-origin Fetch Metadata also
 * authorizes normal browser GETs, which omit Origin.
 */
export function admitSessionBootstrapOrigin(
  request: FastifyRequest,
  config: ExtensionProductOriginConfiguration,
): boolean {
  const origin = request.headers.origin;
  const originAllowsRotation = typeof origin === 'string'
    && origin.length > 0
    && origin !== 'null'
    && config.allowedOrigins.includes(origin);
  if (origin !== undefined && !originAllowsRotation) {
    requireAllowedOrigin(request, extensionProductAllowedOrigins(config));
  }
  return originAllowsRotation;
}

/**
 * A rotated-away predecessor cookie no longer authenticates, but its rotation
 * successor is still live. Revoke that lineage before clearing the cookie;
 * the authority follows the successor links. Best effort: logout stays
 * idempotent and always answers 204.
 */
export async function revokeRotatedSuccessorOnLogout(input: {
  readonly authority: BrowserSessionAuthority;
  readonly request: FastifyRequest;
}): Promise<void> {
  const cookie = input.request.headers.cookie;
  if (cookie === undefined) return;
  try {
    await input.authority.signOut({ cookie });
  } catch (error: unknown) {
    input.request.log.warn(
      {
        classification: 'logout_successor_revoke_failed',
        ...(error instanceof Error ? { name: error.name } : {}),
      },
      'logout could not revoke the rotated successor session',
    );
  }
}
