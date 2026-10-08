/**
 * MCP-U-05 (2026-08-27 MCP usability audit): honest guidance for opaque
 * `client_id` values.
 *
 * Unknown non-CIMD `client_id` strings that are also absent from the DCR
 * table used to fall through `getClient() -> null`, which Better Auth reports
 * as the misleading `client_id is required`. This discovery runs after CIMD
 * and the registered-client table.
 *
 * This companion plugin contributes a terminal client discovery that matches
 * every `client_id` the CIMD discovery cannot handle (anything that is not an
 * `https:` URL) and fails with the real requirement instead. It never
 * resolves a client. Database-registered and trusted clients are unaffected:
 * `getClient()` consults those sources before any discovery, and discoveries
 * only run for otherwise-unknown client ids.
 */
import { isCimdClientIdUrlCandidate } from '@better-auth/cimd';
import { extendOAuthProvider, type ClientDiscovery } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';

export const OPAQUE_CLIENT_ID_GUIDANCE =
  'client_id must be a registered OAuth client: the HTTPS URL of a Client ID Metadata Document (CIMD), '
  + 'or the client_id returned by POST /api/v1/auth/oauth2/register (RFC 7591). '
  + 'Unregistered opaque strings are not accepted. See https://know-n.com/mcp';

const opaqueClientIdDiscovery: ClientDiscovery = {
  id: 'known-opaque-client-id-guidance',
  matches: (clientId) => !isCimdClientIdUrlCandidate(clientId),
  resolve: async () => {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_client',
      error_description: OPAQUE_CLIENT_ID_GUIDANCE,
    });
  },
};

/**
 * Registered right after `cimd()` in the issuer plugin list; CIMD URL
 * candidates keep their precise per-rule CIMD errors, everything else gets
 * this guidance instead of a null-client fallthrough.
 */
export function opaqueClientIdGuidance(): BetterAuthPlugin {
  return {
    id: 'known-opaque-client-id-guidance',
    init(ctx) {
      extendOAuthProvider(ctx, { clientDiscovery: opaqueClientIdDiscovery });
    },
  };
}
