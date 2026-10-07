import { AccountCredentialCommandError } from './errors.js';
import { authenticateChildKey, type CredentialAuthoritySnapshot } from './authority.js';
import {
  ACCOUNT_KEY_TOKEN_TTL_SECONDS,
  parseAccountKeyTokenRequest,
  resolveAccountKeyAudience,
  signAccountKeyAccessToken,
  sortScopeTokens,
  type AccountKeyAudienceConfig,
  type AccountKeyEs256PrivateJwk,
  type AccountKeyTokenRequest,
} from './token.js';
import { AccountKeyOAuthError, invalidGrant, invalidRequest } from './oauth-error.js';
import type { AccountCredentialCommandPorts } from './types.js';

export interface AccountKeyTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: 300;
  readonly scope: string;
  readonly audience: 'product' | 'mcp_strict' | 'mcp_compat';
}

export async function exchangeAccountKey(
  ports: AccountCredentialCommandPorts,
  input: {
    readonly body: unknown;
    readonly supportedScopes: readonly string[];
    readonly audienceConfig: AccountKeyAudienceConfig;
    readonly privateJwk: AccountKeyEs256PrivateJwk;
    readonly issuer: string;
    readonly ttlSeconds?: number;
  },
): Promise<AccountKeyTokenResponse> {
  const parsed = parseAccountKeyTokenRequest(input.body, input.supportedScopes);
  if (parsed instanceof AccountKeyOAuthError) throw parsed;
  let snapshot: CredentialAuthoritySnapshot;
  try {
    snapshot = await authenticateChildKey(ports, parsed.credential);
  } catch (error) {
    if (error instanceof AccountCredentialCommandError) throw invalidGrant();
    throw error;
  }
  let audienceUrl: string;
  try {
    audienceUrl = resolveAccountKeyAudience(parsed.audience, input.audienceConfig);
  } catch (error) {
    if (error instanceof AccountKeyOAuthError) throw error;
    throw error;
  }
  const now = await ports.clock.now();
  const accessToken = await signAccountKeyAccessToken({
    privateJwk: input.privateJwk,
    issuer: input.issuer,
    audienceUrl,
    subjectId: snapshot.account.subjectId,
    scopes: parsed.scopes,
    credentialId: snapshot.credential.id,
    accountEpoch: snapshot.account.securityEpoch.toString(10),
    credentialEpoch: snapshot.credential.epoch.toString(10),
    ancestorEpoch: snapshot.ancestorEpoch,
    clientId: snapshot.credential.mcpClientId,
    now,
    ttlSeconds: input.ttlSeconds ?? ACCOUNT_KEY_TOKEN_TTL_SECONDS,
  });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 300,
    scope: sortScopeTokens(parsed.scopes),
    audience: parsed.audience,
  };
}

export function requireJsonObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('The request body is invalid.');
  }
  return body as Record<string, unknown>;
}

export type { AccountKeyTokenRequest };
