import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  createExtensionCredentialEvidenceVerifier,
  type ExtensionAuthConfig,
  type VerifiedExtensionCredential,
} from '../../src/modules/identity/index.js';

export async function mintVerifiedExtensionCredentialFixture(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly subject: string;
  readonly credentialId: string;
  readonly now?: Date;
  readonly evidenceTtlSeconds?: number;
}): Promise<VerifiedExtensionCredential> {
  return (await mintExtensionCredentialHttpFixture(input)).credential;
}

export async function mintExtensionCredentialHttpFixture(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly subject: string;
  readonly credentialId: string;
  readonly now?: Date;
  readonly evidenceTtlSeconds?: number;
}): Promise<{ readonly authorization: string; readonly credential: VerifiedExtensionCredential;
  readonly jwk: JWK;
  readonly verifier: ReturnType<typeof createExtensionCredentialEvidenceVerifier> }> {
  const now = input.now ?? new Date();
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid: `fixture-${input.credentialId}`, alg: 'RS256', use: 'sig' });
  const config: ExtensionAuthConfig = {
    flow: 'authorization_code_pkce', issuer: input.issuer, audience: input.audience,
    clientId: input.clientId, authorizationEndpoint: `${input.issuer}/authorize`,
    tokenEndpoint: `${input.issuer}/token`, jwksUri: `${input.issuer}/jwks`,
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
    allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    allowedRedirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
    scopes: ['known.sync'], allowedAlgorithms: ['RS256'], clockSkewSeconds: 0,
    evidenceTtlSeconds: input.evidenceTtlSeconds ?? 60,
  };
  const seconds = Math.floor(now.getTime() / 1_000);
  const token = await new SignJWT({ scope: 'known.sync', client_id: input.clientId })
    .setProtectedHeader({ alg: 'RS256', kid: `fixture-${input.credentialId}` })
    .setIssuer(input.issuer).setSubject(input.subject).setAudience(input.audience)
    .setIssuedAt(seconds - 1).setExpirationTime(seconds + 3_600)
    .setJti(input.credentialId).sign(pair.privateKey);
  const verifier = createExtensionCredentialEvidenceVerifier({
    config, jwks: { async getKeySet() { return { keys: [jwk] }; } },
    requiredScopes: ['known.sync'], isRevoked: async () => false, now: () => now,
  });
  const authorization = `Bearer ${token}`;
  const credential = await verifier.verify({ authorization });
  return Object.freeze({ authorization, credential, jwk, verifier });
}

export async function verifyExtensionCredentialFixture(input: {
  readonly authorization: string;
  readonly jwk: JWK;
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly now?: Date;
  readonly evidenceTtlSeconds?: number;
}): Promise<VerifiedExtensionCredential> {
  const now = input.now ?? new Date();
  const config: ExtensionAuthConfig = {
    flow: 'authorization_code_pkce', issuer: input.issuer, audience: input.audience,
    clientId: input.clientId, authorizationEndpoint: `${input.issuer}/authorize`,
    tokenEndpoint: `${input.issuer}/token`, jwksUri: `${input.issuer}/jwks`,
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
    allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    allowedRedirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
    scopes: ['known.sync'], allowedAlgorithms: ['RS256'], clockSkewSeconds: 0,
    evidenceTtlSeconds: input.evidenceTtlSeconds ?? 60,
  };
  const verifier = createExtensionCredentialEvidenceVerifier({
    config, jwks: { async getKeySet() { return { keys: [input.jwk] }; } },
    requiredScopes: ['known.sync'], isRevoked: async () => false, now: () => now,
  });
  return verifier.verify({ authorization: input.authorization });
}
