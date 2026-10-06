import type { AuthorizationAdapter } from '../security/index.js';
import {
  deriveRemoteApplicability,
  enforceHttpsFromTransport,
  enforceOriginFromTransport,
  enforcePublisherStreamableHttpBoundary,
  type HttpsEndpointDecision,
  type OriginGuardDecision,
  type PublisherStreamableHttpBoundaryDecision,
  type RemoteApplicability,
  type TrustedTransportEvidence,
} from '../security/index.js';
import type { TransactionManager } from '../server/index.js';

export interface CollectionProtocolModuleOptions {
  readonly mountPath: string;
  readonly publicOrigin: string;
  readonly authorization: AuthorizationAdapter;
  readonly transactions: TransactionManager;
  readonly features: {
    readonly directory?: boolean;
    readonly publisher?: boolean;
    readonly feed?: boolean;
    readonly sync?: boolean;
    readonly mcp?: boolean;
    readonly admin?: boolean;
  };
}

export interface PublisherHttpBoundaryOptions {
  /**
   * Exact HTTPS Origin allowlist for remote Streamable HTTP (SEC-0016).
   * When omitted, `publicOrigin` (if provided) is used as a single-entry list.
   */
  readonly allowedOrigins?: readonly string[];
  /** Deployment public origin; used as the default Origin allowlist entry. */
  readonly publicOrigin?: string;
}

export interface PublisherHttpBoundary {
  /**
   * Derive remote/applicability solely from trusted transport evidence.
   * Callers cannot override `remote` independently of network exposure.
   */
  readonly deriveRemote: (evidence: TrustedTransportEvidence) => RemoteApplicability;
  /** HTTPS MUST via composition — no free-form `remote` override. */
  readonly enforceHttps: (evidence: TrustedTransportEvidence) => HttpsEndpointDecision;
  /**
   * Origin allowlist for Streamable HTTP when remote; otherwise not_applicable.
   * Uses the factory's configured allowlist (`publicOrigin` / `allowedOrigins`).
   */
  readonly enforceOrigin: (evidence: TrustedTransportEvidence) => OriginGuardDecision;
  /**
   * Ordered HTTPS → Origin composition for publisher Streamable HTTP.
   * Fail closed on the first denial.
   */
  readonly enforceStreamableHttpBoundary: (
    evidence: TrustedTransportEvidence,
  ) => PublisherStreamableHttpBoundaryDecision;
}

function resolveAllowedOrigins(options: PublisherHttpBoundaryOptions): readonly string[] {
  if (options.allowedOrigins !== undefined) {
    return Object.freeze(options.allowedOrigins.slice());
  }
  if (typeof options.publicOrigin === 'string' && options.publicOrigin.length > 0) {
    return Object.freeze([options.publicOrigin]);
  }
  return Object.freeze([]);
}

/**
 * Factory for NestJS / publisher HTTP request-boundary guards.
 *
 * Returns runtime composition helpers that call the security request-boundary
 * API using trusted {@link TrustedTransportEvidence}. Full HTTP route
 * middleware is not installed here — callers attach these functions at the
 * transport edge when the HTTP server exists.
 *
 * Handlers must not invoke atomic `enforceHttpsEndpoint` / `enforceOriginGuard`
 * with a self-asserted `remote: false`; use this boundary instead (M-1).
 */
export function createPublisherHttpBoundary(
  options: PublisherHttpBoundaryOptions = {},
): PublisherHttpBoundary {
  const allowedOrigins = resolveAllowedOrigins(options);

  return Object.freeze({
    deriveRemote(evidence: TrustedTransportEvidence): RemoteApplicability {
      return deriveRemoteApplicability(evidence);
    },
    enforceHttps(evidence: TrustedTransportEvidence): HttpsEndpointDecision {
      return enforceHttpsFromTransport(evidence);
    },
    enforceOrigin(evidence: TrustedTransportEvidence): OriginGuardDecision {
      return enforceOriginFromTransport(evidence, allowedOrigins);
    },
    enforceStreamableHttpBoundary(
      evidence: TrustedTransportEvidence,
    ): PublisherStreamableHttpBoundaryDecision {
      return enforcePublisherStreamableHttpBoundary(evidence, { allowedOrigins });
    },
  });
}

export type {
  HttpsEndpointDecision,
  OriginGuardDecision,
  PublisherStreamableHttpBoundaryDecision,
  RemoteApplicability,
  TrustedTransportEvidence,
};
