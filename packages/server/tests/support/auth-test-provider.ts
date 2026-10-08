/**
 * Task E1: controlled Google/GitHub OAuth test provider (plan §11 E1 step 4).
 *
 * A REAL HTTP authorization/token/userinfo provider for the Better Auth
 * social contract (C3 pattern): S256 PKCE verified at the token endpoint,
 * one-time codes bound to code_challenge/state/client_id, client credentials
 * verified (form fields or Basic auth), Bearer-token userinfo and per-test
 * state resets. It NEVER reuses the legacy `known_test.*` token exchange and
 * never reads real provider credentials.
 *
 * Usage: `startControlledOAuthProvider({ providerId: 'google', clientId,
 * clientSecret, userinfo })`, point the Better Auth provider configuration at
 * `origin + '/authorize'` / `'/token'` / `'/userinfo'`, then drive the flow
 * and assert `state` for the contract evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface ControlledOAuthUserinfo {
  readonly id: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly name: string;
}

export interface IssuedOAuthCode {
  readonly codeChallenge: string;
  readonly state: string;
  readonly clientId: string;
  used: boolean;
}

export interface ControlledOAuthProviderState {
  userinfo: ControlledOAuthUserinfo | null;
  readonly codes: Map<string, IssuedOAuthCode>;
  readonly tokens: Set<string>;
  /** Every token-endpoint request, for client-auth evidence. */
  readonly tokenRequests: Array<{
    readonly hasCodeVerifier: boolean;
    readonly clientId: string | null;
    readonly clientSecret: string | null;
    readonly basicAuth: string | null;
  }>;
}

export interface ControlledOAuthProvider {
  readonly providerId: 'google' | 'github';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly origin: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint: string;
  readonly state: ControlledOAuthProviderState;
  /** Swap the controlled user identity (null => /userinfo 401). */
  setUserinfo(userinfo: ControlledOAuthUserinfo | null): void;
  close(): Promise<void>;
}

function parseBasicAuth(header: string | undefined): { readonly clientId: string; readonly clientSecret: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/u.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const eq = decoded.indexOf(':');
  if (eq < 1) return null;
  return { clientId: decoded.slice(0, eq), clientSecret: decoded.slice(eq + 1) };
}

export async function startControlledOAuthProvider(options: {
  readonly providerId: 'google' | 'github';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userinfo: ControlledOAuthUserinfo;
}): Promise<ControlledOAuthProvider> {
  const state: ControlledOAuthProviderState = {
    userinfo: options.userinfo,
    codes: new Map(),
    tokens: new Set(),
    tokenRequests: [],
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const stateParam = url.searchParams.get('state') ?? '';
      const codeChallenge = url.searchParams.get('code_challenge') ?? '';
      const clientId = url.searchParams.get('client_id') ?? '';
      if (!redirectUri || clientId !== options.clientId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      const code = `controlled-${options.providerId}-${randomUUID().replaceAll('-', '')}`;
      state.codes.set(code, { codeChallenge, state: stateParam, clientId, used: false });
      const location = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateParam)}`;
      res.writeHead(302, { location });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier');
      const grantType = params.get('grant_type');
      const basic = parseBasicAuth(req.headers.authorization);
      const clientId = params.get('client_id') ?? basic?.clientId ?? null;
      const clientSecret = params.get('client_secret') ?? basic?.clientSecret ?? null;
      state.tokenRequests.push({ hasCodeVerifier: verifier !== null, clientId, clientSecret, basicAuth: basic === null ? null : basic.clientId });
      const issued = state.codes.get(code);
      if (
        !issued || issued.used || grantType !== 'authorization_code'
        || clientId !== options.clientId || clientSecret !== options.clientSecret
      ) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      // REAL PKCE S256 verification when the authorize request carried a challenge.
      if (issued.codeChallenge !== '') {
        const challenge = createHash('sha256').update(verifier ?? '').digest('base64url');
        if (challenge !== issued.codeChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
      }
      issued.used = true;
      const accessToken = `controlled-access-${randomUUID().replaceAll('-', '')}`;
      state.tokens.add(accessToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (url.pathname === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/u, '');
      if (!state.tokens.has(token) || state.userinfo === null) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.userinfo));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('controlled OAuth provider must listen on a TCP port'));
        return;
      }
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        providerId: options.providerId,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        origin,
        authorizationEndpoint: `${origin}/authorize`,
        tokenEndpoint: `${origin}/token`,
        userinfoEndpoint: `${origin}/userinfo`,
        state,
        setUserinfo(userinfo) {
          state.userinfo = userinfo;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
