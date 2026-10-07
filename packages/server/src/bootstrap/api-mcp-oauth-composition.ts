import { loadConfig } from './config.js';
import { createCachingJwksClient } from '../infrastructure/identity/index.js';
import type { JwksProvider } from '../modules/identity/index.js';
import {
  createMcpOauthVerifier,
  createPhase4bMcpReadDependencyHealthProvider,
  mcpOauthAcceptedAudiences,
  MCP_OAUTH_DEFAULT_SECURITY_EPOCH,
  type McpOauthAccountResolver,
  type McpOauthRevocationStore,
  type McpOauthVerifier,
  type McpOauthVerifierOptions,
  type Phase4bMcpReadDependencyHealth,
} from '../modules/mcp/index.js';
import { supportedAccountKeyScopes } from '../modules/auth/index.js';

export interface McpReadOAuthTransportDependenciesOptions {
  readonly jwksProvider?: JwksProvider;
  /**
   * FIX-L-042 shared revocation store (issuer/subject/client/jti/credential
   * digests + rotatable security epoch). Required in production when
   * `MCP_OAUTH_REVOCATION_STORE=postgres`; production without it wires no
   * verifier and reports MCP OAuth unavailable on readiness.
   */
  readonly revocationStore?: McpOauthRevocationStore;
  /**
   * T-A4: maps verified JWT `sub` onto the unique active `accounts` row.
   * Required whenever this factory wires a verifier.
   */
  readonly resolveAccountBySubject?: McpOauthAccountResolver;
  readonly machine?: McpOauthVerifierOptions['machine'];
}

export interface McpReadOAuthDependencyBundle {
  readonly oauthVerifier?: McpOauthVerifier;
  readonly dependencyHealth?: () => Promise<Phase4bMcpReadDependencyHealth>;
}

/** Grant approval and token verification must observe the same live epoch. */
export function createMcpSecurityEpochReader(
  config: Pick<ReturnType<typeof loadConfig>, 'nodeEnv'>,
  store?: Pick<McpOauthRevocationStore, 'securityEpoch'>,
): () => Promise<string> {
  return async () => {
    if (config.nodeEnv !== 'production') return MCP_OAUTH_DEFAULT_SECURITY_EPOCH;
    if (!store) throw new Error('MCP OAuth security epoch is unavailable');
    return store.securityEpoch();
  };
}

export function assertMcpWriteOAuthRequirement(
  config: ReturnType<typeof loadConfig>,
): void {
  if (config.mcpWriteEnabled
      && (config.mcp === undefined || config.mcp.oauth.jwksUri === null)) {
    throw new Error('KNOWN_FEATURE_MCP_WRITE requires MCP OAuth JWKS URI to be configured');
  }
}

export function createMcpReadOAuthTransportDependencies(
  config: ReturnType<typeof loadConfig>,
  options: McpReadOAuthTransportDependenciesOptions = {},
): McpReadOAuthDependencyBundle {
  if (config.mcp === undefined) return {};
  if (config.mcp.oauth.jwksUri === null) {
    return {
      dependencyHealth: async () => Object.freeze({
        oauth: 'unavailable',
        signalSource: 'ready',
        projection: 'ready',
      } satisfies Phase4bMcpReadDependencyHealth),
    };
  }
  const jwks = options.jwksProvider ?? createCachingJwksClient({
    jwksUri: config.mcp.oauth.jwksUri,
    fetchTimeoutMs: 5_000,
    cacheMaxAgeMs: 30_000,
  });
  if (config.nodeEnv === 'production') {
    if (options.revocationStore === undefined || config.mcp.oauth.revocationStore !== 'postgres') {
      // FIX-L-042: production without the shared revocation store must not
      // pretend revocation is checked: no verifier is wired (authenticated
      // requests fail closed) and readiness reports MCP OAuth unavailable.
      return {
        dependencyHealth: async () => Object.freeze({
          oauth: 'unavailable',
          signalSource: 'ready',
          projection: 'ready',
        } satisfies Phase4bMcpReadDependencyHealth),
      };
    }
    const store = options.revocationStore;
    const readAccountSecurityBoundary = store.readAccountSecurityBoundary;
    const resolveAccountBySubject = requireMcpAccountResolver(options.resolveAccountBySubject);
    return {
      oauthVerifier: createMcpOauthVerifier({
        issuer: config.mcp.oauth.issuer,
        audience: mcpOauthAcceptedAudiences(config.mcp.oauth.audience),
        allowedScopes: supportedAccountKeyScopes(config.mcp.oauth.scopes),
        jwks,
        isRevoked: (input) => store.isRevoked(input),
        securityEpoch: createMcpSecurityEpochReader(config, store),
        resolveAccountBySubject,
        requireAccountEpoch: config.betterAuth.oauthIssuerEnabled,
        ...(readAccountSecurityBoundary === undefined
          ? {}
          : { readAccountSecurityBoundary: (accountId: string) => readAccountSecurityBoundary(accountId) }),
        ...(options.machine ? { machine: options.machine } : {}),
      }),
      dependencyHealth: createPhase4bMcpReadDependencyHealthProvider({
        jwks,
        revocationStore: store,
      }),
    };
  }
  // Development/test provider: revocation is not enforced and the epoch is the
  // fixed default; production uses the shared store above (FIX-L-042).
  const resolveAccountBySubject = requireMcpAccountResolver(options.resolveAccountBySubject);
  return {
    oauthVerifier: createMcpOauthVerifier({
      issuer: config.mcp.oauth.issuer,
      audience: mcpOauthAcceptedAudiences(config.mcp.oauth.audience),
      allowedScopes: supportedAccountKeyScopes(config.mcp.oauth.scopes),
      jwks,
      isRevoked: async () => false,
      securityEpoch: createMcpSecurityEpochReader(config),
      resolveAccountBySubject,
      requireAccountEpoch: config.betterAuth.oauthIssuerEnabled,
      ...(options.machine ? { machine: options.machine } : {}),
    }),
    dependencyHealth: createPhase4bMcpReadDependencyHealthProvider({ jwks }),
  };
}

function requireMcpAccountResolver(
  resolver: McpOauthAccountResolver | undefined,
): McpOauthAccountResolver {
  if (resolver === undefined) {
    throw new Error('MCP OAuth verifier requires resolveAccountBySubject');
  }
  return resolver;
}
