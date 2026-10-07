/**
 * OAuth constants and token helpers shared by in-memory and PostgreSQL MCP
 * compat tests. This module intentionally depends only on the installed COLP
 * package surface, never on sibling COLP source or test fixtures.
 */
import { SignJWT, type KeyLike } from 'jose';
import { MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION } from '../../src/modules/mcp/index.js';
import {
  AUDIENCE,
  ISSUER,
  NOW,
  SCOPES,
  SUBJECT,
  mintCredential,
} from './phase4b-mcp-transport-scaffold.js';

const COMPAT_AUDIENCE = `${AUDIENCE}-compat`;

export const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;

export const COMPAT_WRITE_SCOPES = Object.freeze([
  ...SCOPES,
  'nodes:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
] as const);

export const COMPAT_READ_SCOPES = SCOPES;

export async function mintCompatWriteToken(input: {
  readonly key: KeyLike;
  readonly kid: string;
  readonly scopes?: readonly string[];
  readonly subject?: string;
  readonly jti?: string;
  readonly clientId?: string;
  readonly audience?: string;
}): Promise<string> {
  const audience = input.audience ?? COMPAT_AUDIENCE;
  if (input.clientId === undefined) {
    return mintCredential({
      key: input.key,
      kid: input.kid,
      scope: input.scopes ?? COMPAT_WRITE_SCOPES,
      subject: input.subject,
      jti: input.jti,
      audience,
    });
  }
  const nowSeconds = Math.floor(NOW.getTime() / 1_000);
  return new SignJWT({
    scope: (input.scopes ?? COMPAT_WRITE_SCOPES).join(' '),
    client_id: input.clientId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(ISSUER)
    .setSubject(input.subject ?? SUBJECT)
    .setAudience(audience)
    .setIssuedAt(nowSeconds - 5)
    .setExpirationTime(nowSeconds + 3_600)
    .setJti(input.jti ?? 't06-write-jti-client')
    .sign(input.key);
}
