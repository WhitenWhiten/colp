import type { FastifyRequest } from 'fastify';
import type { Account, IdentityUnitOfWork } from '../modules/identity/index.js';
import {
  AccountCredentialCommandError,
  PRODUCT_READ_SCOPE,
  PRODUCT_WRITE_SCOPE,
  authorityMatchesClaims,
  canonicalOrigin,
  loadCredentialAuthority,
  verifyAccountKeyJwt,
  type AccountCredentialsEs256PublicJwk,
} from '../modules/auth/index.js';
// Scope-satisfaction goes through the shared implication table (empty today)
// so future fine-grained scopes are honored without re-minting tokens.
import { grantsScope } from '../modules/mcp/index.js';
import type { PostgresAccountCredentialUnitOfWork } from '../infrastructure/auth/account-credentials-postgres.js';
import { ProductHttpError } from './product-error.js';
import { authenticationRequired } from './session-auth.js';

export interface ProductBearerActor {
  readonly account: Account;
  readonly credentialId: string;
  readonly subjectId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export interface ProductBearerAuthority {
  requireRead(request: FastifyRequest): Promise<ProductBearerActor>;
  requireWrite(request: FastifyRequest): Promise<ProductBearerActor>;
  inspect(request: FastifyRequest): Promise<ProductBearerActor>;
}

export function createProductBearerAuthority(input: {
  readonly issuer: string;
  readonly productOrigin: string;
  readonly publicKeys: readonly AccountCredentialsEs256PublicJwk[];
  readonly clockSkewSeconds: number;
  readonly unitOfWork: PostgresAccountCredentialUnitOfWork;
  readonly identityUnitOfWork: IdentityUnitOfWork;
}): ProductBearerAuthority {
  const audience = canonicalOrigin(input.productOrigin);
  const verify = async (request: FastifyRequest, required: readonly string[]): Promise<ProductBearerActor> => {
    const token = readSingleBearer(request);
    let claims;
    try {
      claims = await verifyAccountKeyJwt({
        token,
        issuer: input.issuer,
        audience,
        publicKeys: input.publicKeys,
        now: new Date(),
        clockSkewSeconds: input.clockSkewSeconds,
      });
    } catch {
      throw authenticationRequired();
    }
    if (required.some((scope) => !grantsScope(claims.scopes, scope))) {
      throw new ProductHttpError({
        statusCode: 403,
        code: 'insufficient_permission',
        message: 'The access token is missing a required scope.',
      });
    }
    const snapshot = await input.unitOfWork.execute((ports) => loadCredentialAuthority(ports, claims.known_credential_id));
    if (!snapshot || !authorityMatchesClaims(snapshot, claims)) {
      throw authenticationRequired();
    }
    const account = await input.identityUnitOfWork.execute((ports) => ports.accounts.findById(snapshot.account.id));
    if (!account || account.status !== 'active' || account.deletedAt !== null) {
      throw authenticationRequired();
    }
    return {
      account,
      credentialId: snapshot.credential.id,
      subjectId: account.subjectId,
      scopes: claims.scopes,
      expiresAt: new Date(claims.exp * 1000),
    };
  };
  return {
    requireRead: (request) => verify(request, [PRODUCT_READ_SCOPE]),
    requireWrite: (request) => verify(request, [PRODUCT_WRITE_SCOPE]),
    inspect: (request) => verify(request, []),
  };
}

export function hasAuthorizationHeader(request: FastifyRequest): boolean {
  return request.headers.authorization !== undefined;
}

export function hasCookieHeader(request: FastifyRequest): boolean {
  return request.headers.cookie !== undefined;
}

export function rejectMixedCarriers(request: FastifyRequest): void {
  if (hasCookieHeader(request) && hasAuthorizationHeader(request)) {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'Cookie and Authorization cannot be used together.',
    });
  }
}

const AUTOMATION_IDENTITY_KEYS = Object.freeze([
  'isBot',
  'automation',
  'credentialId',
  'issuanceSource',
  'issuance_source',
  'known_credential_id',
  'knownCredentialId',
  'identitySource',
  'identity_source',
]);

/**
 * Ordinary DTOs omit issuance-source fields when EXPOSE_AUTOMATION_IDENTITY
 * is false. Does not rewrite string values in user body text.
 */
export function omitAutomationIdentityFields<T extends Record<string, unknown>>(
  value: T,
  exposeAutomationIdentity: boolean,
): T {
  if (exposeAutomationIdentity) return value;
  const next = { ...value };
  for (const key of AUTOMATION_IDENTITY_KEYS) {
    delete next[key];
  }
  return next;
}

export function readSingleBearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.includes(',')) throw authenticationRequired();
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  if (!match) throw authenticationRequired();
  return match[1]!;
}

export function productBearerAuthorityOf(request: FastifyRequest): ProductBearerAuthority | null {
  return request.server.productBearerAuthority ?? null;
}

/**
 * Returns the verified Product bearer actor for a request, or `null` when the
 * request is not carrying a bearer token (e.g. an ordinary browser session).
 * Callers that gate bearer-only behavior use this to distinguish the carrier
 * instead of guessing from scopes. Mixed Cookie+Authorization is rejected by
 * the shared admission before this helper is reached.
 */
export async function productBearerActorOf(
  request: FastifyRequest,
): Promise<ProductBearerActor | null> {
  if (!hasAuthorizationHeader(request)) return null;
  const authority = productBearerAuthorityOf(request);
  if (!authority) throw authenticationRequired();
  return authority.inspect(request);
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly productBearerAuthority?: ProductBearerAuthority;
  }
}

export { PRODUCT_READ_SCOPE, PRODUCT_WRITE_SCOPE, AccountCredentialCommandError };
