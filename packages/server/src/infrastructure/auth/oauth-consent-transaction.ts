/**
 * Consent-page lookup for a server-verified, authorization-transaction-bound
 * redirect URI.
 *
 * Better Auth signs the authorize query (`signParams`: canonicalize + HMAC
 * `sig` + `exp`) before redirecting to `/consent`. Displaying
 * `searchParams.get('redirect_uri')` without that check would let an
 * attacker-crafted `/consent` link spoof the callback. This plugin verifies
 * the same canonicalize + `sig` + expiry Better Auth uses, then returns:
 *
 * - `client_id` / `redirect_uri` from the **signed** query
 * - `client_name` from issuer/client lookup (never query `client_name`)
 *
 * Session-required (same as GET `/oauth2/public-client`). Not a public AS
 * endpoint: Origin/CSRF skip lists must not include it.
 */
import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';

type OAuthProviderApiContext = Parameters<typeof getOAuthProviderApi>[0];
type OAuthProviderApiOptions = Parameters<typeof getOAuthProviderApi>[1];

export const OAUTH_CONSENT_TRANSACTION_PATH = '/oauth2/consent-transaction' as const;

export interface OAuthConsentTransaction {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly client_name?: string;
}

/**
 * Better Auth `canonicalizeOAuthQueryParams`: sort every entry by key then
 * value and rebuild. Duplicate keys (e.g. `ba_param`) must survive.
 */
export function canonicalizeOAuthQueryParams(params: URLSearchParams): URLSearchParams {
  const canonicalParams = new URLSearchParams();
  const entries = [...params.entries()].sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    if (valueA < valueB) return -1;
    if (valueA > valueB) return 1;
    return 0;
  });
  for (const [key, value] of entries) canonicalParams.append(key, value);
  return canonicalParams;
}

/**
 * Better Auth `verifyOAuthQueryParams`: single `sig`, HMAC over canonical
 * query with `sig` removed, and `exp` still in the future.
 */
export async function verifySignedOAuthQuery(
  oauthQuery: string,
  secret: string,
): Promise<boolean> {
  const queryParams = new URLSearchParams(oauthQuery);
  const sig = queryParams.get('sig');
  const sigs = queryParams.getAll('sig');
  const exp = Number(queryParams.get('exp'));
  queryParams.delete('sig');
  const verifySig = await makeSignature(canonicalizeOAuthQueryParams(queryParams).toString(), secret);
  if (sigs.length !== 1 || sig === null || sig.length === 0) return false;
  return constantTimeEqual(sig, verifySig)
    && new Date(exp * 1_000) >= new Date();
}

export function signedConsentTransactionFields(oauthQuery: string): {
  readonly clientId: string;
  readonly redirectUri: string;
} | null {
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  if (clientId === null || clientId.length === 0) return null;
  if (redirectUri === null || redirectUri.length === 0) return null;
  return { clientId, redirectUri };
}

function oauthQueryFromRequest(request: Request): string {
  try {
    return new URL(request.url, 'http://localhost').searchParams.get('oauth_query') ?? '';
  } catch {
    return '';
  }
}

function failClosed(): never {
  throw new APIError('BAD_REQUEST', { error: 'invalid_signature' });
}

async function issuerClientName(
  ctx: OAuthProviderApiContext,
  clientId: string,
): Promise<string | undefined> {
  const plugin = ctx.context.getPlugin('oauth-provider');
  if (plugin == null || !('options' in plugin) || plugin.options === undefined) return undefined;
  try {
    const client = await getOAuthProviderApi(ctx, plugin.options as OAuthProviderApiOptions).getClient(clientId);
    if (client === null || client.disabled === true) return undefined;
    const name = client.name?.trim();
    return name !== undefined && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session-gated GET that verifies the consent page's signed `oauth_query` and
 * returns the transaction redirect. Mounted only with the issuer allowlist.
 */
export function oauthConsentTransaction(): BetterAuthPlugin {
  return {
    id: 'known-oauth-consent-transaction',
    endpoints: {
      getOAuthConsentTransaction: createAuthEndpoint(OAUTH_CONSENT_TRANSACTION_PATH, {
        method: 'GET',
        use: [sessionMiddleware],
        requireRequest: true,
      }, async (ctx) => {
        const oauthQuery = oauthQueryFromRequest(ctx.request);
        if (oauthQuery.length === 0) failClosed();
        if (!await verifySignedOAuthQuery(oauthQuery, ctx.context.secret)) failClosed();
        const signed = signedConsentTransactionFields(oauthQuery);
        if (signed === null) failClosed();
        const clientName = await issuerClientName(ctx, signed.clientId);
        const body: OAuthConsentTransaction = clientName === undefined
          ? { client_id: signed.clientId, redirect_uri: signed.redirectUri }
          : { client_id: signed.clientId, redirect_uri: signed.redirectUri, client_name: clientName };
        return body;
      }),
    },
  };
}
