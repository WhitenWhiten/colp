import { IdentityError } from './errors.js';
import { assertValidAvatarUrl, assertValidDisplayName, assertValidEmail } from './validation.js';

/**
 * Provider/tenant policy for treating OIDC email as a trusted product claim.
 *
 * Phase 1 default: allow login without a verified email, but never store or
 * overwrite product email from an unverified claim.
 */
export interface OidcEmailTrustPolicy {
  /**
   * When true, login/ensure fails unless a present, valid, verified email claim
   * is supplied. Default false.
   */
  readonly requireVerifiedEmail: boolean;
}

export const DEFAULT_OIDC_EMAIL_TRUST_POLICY: OidcEmailTrustPolicy = Object.freeze({
  requireVerifiedEmail: false,
});

/**
 * Low-cardinality sanitized counters for OIDC claim synchronization.
 * Metric names are fixed tokens and never carry claim values, URLs, or
 * identifiers (FIX-M-003).
 */
export interface OidcClaimSyncMetrics {
  increment(name: string, value?: number): void;
}

/** No-op default so callers without telemetry keep strict behavior. */
export const NOOP_OIDC_CLAIM_SYNC_METRICS: OidcClaimSyncMetrics = Object.freeze({
  increment() {},
});

/**
 * Fixed counter recorded when a provider picture claim is discarded.
 * The raw URL is never part of the metric name or any label.
 */
export const OIDC_AVATAR_URL_REJECTED_METRIC = 'identity.oidc.avatar_url_rejected' as const;

/**
 * Mutable product claims that may be synchronized from a verified OIDC login.
 * Identity remains issuer+subject; handle is local-only and never derived here.
 */
export interface TrustedOidcProfileClaims {
  /**
   * Policy-approved email, or null when the claim must not be trusted
   * (missing verification, missing email, or empty).
   */
  readonly trustedEmail: string | null;
  /** True only when trustedEmail is non-null and email_verified was true. */
  readonly emailTrusted: boolean;
  /**
   * Non-empty display name from the provider when present; null means
   * "claim absent/empty — do not overwrite an existing local displayName".
   */
  readonly trustedDisplayName: string | null;
  /**
   * Avatar URL when the picture/avatar claim was present (string or explicit null).
   * undefined means "claim absent — do not overwrite local avatarUrl".
   * A present but invalid picture is discarded to null (FIX-M-003) and counted
   * on OIDC_AVATAR_URL_REJECTED_METRIC.
   */
  readonly trustedAvatarUrl: string | null | undefined;
}

export interface ResolveTrustedOidcClaimsInput {
  readonly email?: string | null;
  /** OIDC email_verified; only the boolean true is trusted. */
  readonly emailVerified?: boolean | null;
  readonly displayName?: string | null;
  /**
   * When the key is present (including null), the avatar claim is considered
   * supplied by the provider. Omit the property when the claim is absent.
   */
  readonly avatarUrl?: string | null;
  readonly emailTrustPolicy?: OidcEmailTrustPolicy;
  /** Optional sanitized counter sink; defaults to a no-op. */
  readonly metrics?: OidcClaimSyncMetrics;
}

/**
 * Resolves which OIDC claims are safe to store or synchronize onto Account/Profile.
 * Does not merge accounts or alter identity subject keys.
 */
export function resolveTrustedOidcClaims(
  input: ResolveTrustedOidcClaimsInput,
): TrustedOidcProfileClaims {
  const policy = input.emailTrustPolicy ?? DEFAULT_OIDC_EMAIL_TRUST_POLICY;
  const metrics = input.metrics ?? NOOP_OIDC_CLAIM_SYNC_METRICS;
  const emailVerified = input.emailVerified === true;
  const rawEmail = input.email;

  let trustedEmail: string | null = null;
  let emailTrusted = false;

  if (rawEmail !== null && rawEmail !== undefined && rawEmail.length > 0) {
    // Always format-check non-empty emails so callers get invalid_email, but only
    // promote to trustedEmail when email_verified === true.
    const validated = assertValidEmail(rawEmail);
    if (emailVerified && validated !== null) {
      trustedEmail = validated;
      emailTrusted = true;
    }
  }

  if (policy.requireVerifiedEmail && !emailTrusted) {
    throw new IdentityError(
      'email_unverified',
      'a verified email claim is required by identity policy',
    );
  }

  let trustedDisplayName: string | null = null;
  if (input.displayName !== null && input.displayName !== undefined) {
    const displayName = assertValidDisplayName(input.displayName, { allowEmpty: true });
    if (displayName.length > 0) {
      trustedDisplayName = displayName;
    }
  }

  let trustedAvatarUrl: string | null | undefined = undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'avatarUrl')) {
    const rawAvatar = input.avatarUrl ?? null;
    if (rawAvatar === null) {
      trustedAvatarUrl = null;
    } else {
      try {
        trustedAvatarUrl = assertValidAvatarUrl(rawAvatar);
      } catch (error) {
        if (error instanceof IdentityError) {
          // FIX-M-003: an untrusted provider picture is discarded to null and
          // counted with a fixed sanitized metric; it never blocks login.
          metrics.increment(OIDC_AVATAR_URL_REJECTED_METRIC);
          trustedAvatarUrl = null;
        } else {
          throw error;
        }
      }
    }
  }

  return {
    trustedEmail,
    emailTrusted,
    trustedDisplayName,
    trustedAvatarUrl,
  };
}
