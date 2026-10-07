import {
  parseOidcEncryptionKeysEnv,
  type OidcEncryptionKey,
} from '../modules/identity/index.js';
import {
  assertOidcEndpointOrigins,
  assertOidcEndpointUrl,
  oidcEndpointPolicyMode,
  parseOidcAllowedEndpointOrigins,
} from './oidc-endpoint-policy.js';
import { requireNonEmpty } from './config-parse-helpers.js';
import type {
  OidcClientAuthMode,
  OidcConfig,
  OidcTransactionSecretsConfig,
} from './config-types.js';

const DEV_OIDC_PKCE_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const DEV_OIDC_HMAC = 'dev-oidc-transaction-hmac-secret-change-me';
const DEV_OIDC_ENCRYPTION_KEYS = `1:oidc-pkce-dev:${DEV_OIDC_PKCE_KEY_B64}`;

export function loadOidcRuntimeConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly productOrigin: string;
    readonly productOriginUrl: URL;
    readonly betterAuthEnabled: boolean;
  },
): {
  readonly oidc: OidcConfig;
  readonly testIdentityProviderEnabled: boolean;
  readonly testAuthMailboxHttp: Readonly<{ enabled: boolean; token: string }>;
} {
  const { nodeEnv, productOrigin, productOriginUrl, betterAuthEnabled } = args;
  const issuer = requireNonEmpty(env, 'OIDC_ISSUER', 'https://issuer.example/realms/known');
  const clientId = requireNonEmpty(env, 'OIDC_CLIENT_ID', 'known-web');
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim() ?? '';
  // FIX-L-001: explicit client auth mode (public client + PKCE is a legal
  // deployment form). Never derived from secret presence; the default keeps
  // legal public deployments working while any secret without an explicit
  // confidential mode is a startup error instead of a silent downgrade.
  const rawClientAuthMode = env.OIDC_CLIENT_AUTH_MODE?.trim() || 'none';
  if (rawClientAuthMode !== 'none' && rawClientAuthMode !== 'client_secret_post') {
    throw new Error('OIDC_CLIENT_AUTH_MODE must be one of: none, client_secret_post');
  }
  const clientAuthMode: OidcClientAuthMode = rawClientAuthMode;
  const redirectUri = requireNonEmpty(
    env,
    'OIDC_REDIRECT_URI',
    `${productOrigin}/api/v1/auth/oidc/callback`,
  );
  const audience = env.OIDC_AUDIENCE?.trim() || clientId;
  const authorizationEndpoint = requireNonEmpty(
    env,
    'OIDC_AUTHORIZATION_ENDPOINT',
    `${issuer.replace(/\/$/, '')}/protocol/openid-connect/auth`,
  );
  const tokenEndpoint = requireNonEmpty(
    env,
    'OIDC_TOKEN_ENDPOINT',
    `${issuer.replace(/\/$/, '')}/protocol/openid-connect/token`,
  );
  const jwksUri = env.OIDC_JWKS_URI?.trim() || null;
  const allowTestProvider = (env.OIDC_ALLOW_TEST_PROVIDER ?? 'false')
    .toLowerCase() === 'true';
  const testProviderHmacSecret = env.OIDC_TEST_PROVIDER_HMAC_SECRET?.trim() ?? '';
  const testIdentityProviderEnabled = (env.KNOWN_ENABLE_E2E_TEST_IDENTITY ?? 'false')
    .toLowerCase() === 'true';
  if (nodeEnv === 'production' && allowTestProvider) {
    throw new Error('OIDC_ALLOW_TEST_PROVIDER must not be enabled in production');
  }
  // The in-process test double is forgeable by design (arbitrary subject), so
  // it must fail closed outside NODE_ENV=test even when explicitly enabled.
  if (allowTestProvider && nodeEnv !== 'test') {
    throw new Error('OIDC_ALLOW_TEST_PROVIDER requires NODE_ENV=test');
  }
  // A public or absent HMAC secret would let anyone mint known_test.* codes.
  if (allowTestProvider && !testProviderHmacSecret) {
    throw new Error('OIDC_TEST_PROVIDER_HMAC_SECRET is required when OIDC_ALLOW_TEST_PROVIDER=true');
  }
  if (testIdentityProviderEnabled && (nodeEnv !== 'test' || !allowTestProvider)) {
    throw new Error(
      'KNOWN_ENABLE_E2E_TEST_IDENTITY requires NODE_ENV=test and OIDC_ALLOW_TEST_PROVIDER=true',
    );
  }
  // E3 test-only auth-mailbox query surface: the in-process C1 mailbox sink
  // lives inside the API process, so the separate real-stack harness process
  // can only read OTP/verification material through an explicit HTTP route.
  // The route is registered ONLY under NODE_ENV=test + an explicit flag and
  // token; the flag must fail closed outside test (never silently off).
  const authMailboxHttpEnabled = (env.KNOWN_AUTH_MAILBOX_HTTP ?? 'false')
    .toLowerCase() === 'true';
  const authMailboxHttpToken = env.KNOWN_AUTH_MAILBOX_HTTP_TOKEN?.trim() ?? '';
  if (authMailboxHttpEnabled && nodeEnv !== 'test') {
    throw new Error('KNOWN_AUTH_MAILBOX_HTTP requires NODE_ENV=test');
  }
  if (authMailboxHttpEnabled && !authMailboxHttpToken) {
    throw new Error('KNOWN_AUTH_MAILBOX_HTTP_TOKEN is required when KNOWN_AUTH_MAILBOX_HTTP=true');
  }
  // Production (and any non-test-provider deployment) must have a coherent
  // issuer/client/JWKS triple so callbacks always verify ID tokens cryptographically.
  // G1 §6: Better Auth mode (BETTER_AUTH_ENABLED=true) makes the legacy OIDC
  // env non-required; legacy mode keeps the existing checks exactly as before.
  if (!allowTestProvider && !jwksUri && !betterAuthEnabled) {
    throw new Error('OIDC_JWKS_URI is required when OIDC_ALLOW_TEST_PROVIDER is not enabled');
  }
  if (nodeEnv === 'production' && !jwksUri && !betterAuthEnabled) {
    throw new Error('OIDC_JWKS_URI is required in production');
  }
  // FIX-L-001: mode/secret conflicts fail at startup, not at the callback.
  if (clientAuthMode === 'none' && clientSecret !== '') {
    throw new Error('OIDC_CLIENT_AUTH_MODE=none requires OIDC_CLIENT_SECRET to be empty');
  }
  if (clientAuthMode === 'client_secret_post' && clientSecret === '') {
    throw new Error(
      'OIDC_CLIENT_AUTH_MODE=client_secret_post requires a non-empty OIDC_CLIENT_SECRET',
    );
  }

  // Self-hosted loopback HTTP is a supported origin. Relaxed mode still
  // rejects userinfo and cloud-metadata hosts. Other editions stay strict
  // unless the test provider is explicitly enabled.
  const endpointMode = env.KNOWN_EDITION === 'self-hosted'
    ? 'relaxed'
    : oidcEndpointPolicyMode({ nodeEnv, allowTestProvider });
  // Issuer is an identifier URL; still reject private/metadata under production policy.
  const issuerUrl = assertOidcEndpointUrl('OIDC_ISSUER', issuer, endpointMode);
  const authorizationUrl = assertOidcEndpointUrl(
    'OIDC_AUTHORIZATION_ENDPOINT',
    authorizationEndpoint,
    endpointMode,
  );
  const tokenUrl = assertOidcEndpointUrl('OIDC_TOKEN_ENDPOINT', tokenEndpoint, endpointMode);
  const jwksUrl = jwksUri
    ? assertOidcEndpointUrl('OIDC_JWKS_URI', jwksUri, endpointMode)
    : null;
  assertOidcEndpointOrigins({
    issuer: issuerUrl,
    endpoints: [
      ['OIDC_AUTHORIZATION_ENDPOINT', authorizationUrl],
      ['OIDC_TOKEN_ENDPOINT', tokenUrl],
      ...(jwksUrl ? [['OIDC_JWKS_URI', jwksUrl] as const] : []),
    ],
    additionalAllowedOrigins: parseOidcAllowedEndpointOrigins(
      env.OIDC_ENDPOINT_ALLOWED_ORIGINS,
      endpointMode,
    ),
  });

  // Callback is our public HTTPS route (product origin), not a provider egress URL.
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUri);
  } catch {
    throw new Error('OIDC_REDIRECT_URI must be a valid absolute URL');
  }
  if (redirectUrl.username !== '' || redirectUrl.password !== '') {
    throw new Error('OIDC_REDIRECT_URI must not contain userinfo');
  }
  if (nodeEnv === 'production') {
    if (redirectUrl.protocol !== 'https:') {
      throw new Error('OIDC_REDIRECT_URI must use https in production');
    }
    if (redirectUrl.origin !== productOriginUrl.origin) {
      throw new Error('OIDC_REDIRECT_URI origin must match PRODUCT_ORIGIN in production');
    }
  } else if (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:') {
    throw new Error('OIDC_REDIRECT_URI must use http or https');
  }

  return {
    oidc: {
      issuer,
      clientId,
      clientAuthMode,
      clientSecret,
      redirectUri,
      audience,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      allowTestProvider,
      testProviderHmacSecret,
    },
    testIdentityProviderEnabled,
    testAuthMailboxHttp: Object.freeze({
      enabled: authMailboxHttpEnabled,
      token: authMailboxHttpToken,
    }),
  };
}

export function loadOidcTransactionSecrets(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly legacyOidcSecretsRequired: boolean;
  },
): OidcTransactionSecretsConfig {
  const { nodeEnv, legacyOidcSecretsRequired } = args;
  // F2 (G1 §16): Better Auth mode (BETTER_AUTH_ENABLED=true) composes NO
  // legacy OIDC chain, so the legacy login-transaction secrets are
  // NON-required: production may start without OIDC_TRANSACTION_* (the
  // values stay inert dev defaults, never composed in BA mode, never
  // logged). Legacy mode keeps the fail-closed requirement exactly as
  // before: production MUST supply non-development secrets.
  const oidcTransactionHmac = requireNonEmpty(
    env,
    'OIDC_TRANSACTION_HMAC_SECRET',
    !legacyOidcSecretsRequired || nodeEnv !== 'production' ? DEV_OIDC_HMAC : undefined,
  );
  if (legacyOidcSecretsRequired && nodeEnv === 'production' && oidcTransactionHmac === DEV_OIDC_HMAC) {
    throw new Error('OIDC_TRANSACTION_HMAC_SECRET must not use the development default in production');
  }
  const encryptionKeysRaw = requireNonEmpty(
    env,
    'OIDC_TRANSACTION_ENCRYPTION_KEYS',
    !legacyOidcSecretsRequired || nodeEnv !== 'production' ? DEV_OIDC_ENCRYPTION_KEYS : undefined,
  );
  if (legacyOidcSecretsRequired && nodeEnv === 'production' && encryptionKeysRaw === DEV_OIDC_ENCRYPTION_KEYS) {
    throw new Error('OIDC_TRANSACTION_ENCRYPTION_KEYS must not use the development default in production');
  }
  let oidcEncryptionKeys: readonly OidcEncryptionKey[];
  try {
    oidcEncryptionKeys = Object.freeze(parseOidcEncryptionKeysEnv(encryptionKeysRaw));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'invalid encryption keys';
    throw new Error(message);
  }
  return {
    hmacSecret: oidcTransactionHmac,
    encryptionKeys: oidcEncryptionKeys,
  };
}
