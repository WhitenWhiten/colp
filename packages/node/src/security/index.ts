/**
 * Security module public entry-point. Re-exports only — implementation lives
 * in domain modules (e.g. `./effective-scopes.js`, `./rate-limit.js`).
 */

export {
  evaluateEffectiveScopes,
  hasEffectiveScope,
  resolveRequestIdentities,
  type PrincipalType,
  type Principal,
  type IdentityResolution,
  type EffectiveScopeInput,
  type EffectivePolicyChain,
  type AuthorizationAction,
  type AuthorizationAdapter,
} from './effective-scopes.js';

export {
  PUBLIC_RATE_LIMIT_CREDENTIAL_KEY,
  RATE_LIMIT_BUCKET_IDS,
  classifyRateLimitBucket,
  enforceRateLimit,
  enforceRateLimitForOperation,
  isRateLimitBucketId,
  serializeRateLimitFields,
  type AtomicRateLimitCeiling,
  type AtomicRateLimitCeilingResult,
  type AtomicRateLimitCharge,
  type AtomicRateLimitPort,
  type AtomicRateLimitRequest,
  type AtomicRateLimitResult,
  type EnforceRateLimitForOperationInput,
  type EnforceRateLimitForOperationResult,
  type GoverningRateLimitCeiling,
  type RateLimitCeilingConfiguration,
  type RateLimitCeilings,
  type RateLimitDecision,
  type RateLimitDimension,
  type RateLimitFields,
  type RateLimitAuthentication,
  type RateLimitBucketCategory,
  type RateLimitBucketDecision,
  type RateLimitBucketId,
  type RateLimitClassificationInput,
  type RateLimitOperation,
} from './rate-limit.js';

export {
  MAX_EXPANDED_OPERATIONS,
  PUBLISHER_OPERATION_WEIGHTS,
  calculateExpandedOperationCost,
  enforcePublisherAdmission,
  enforceSubscriptionLimits,
  type AtomicPublisherAdmission,
  type AtomicPublisherAdmissionPort,
  type AtomicPublisherAdmissionResult,
  type AtomicPublisherCeiling,
  type AtomicPublisherCeilingResult,
  type AtomicPublisherGrantDebit,
  type AtomicPublisherGrantResult,
  type AtomicSubscriptionLimit,
  type AtomicSubscriptionLimitPort,
  type AtomicSubscriptionLimitResult,
  type AtomicSubscriptionReservation,
  type AtomicSubscriptionReservationResult,
  type ExpandedOperationCostDecision,
  type ExpandedPublisherOperation,
  type PublisherAdmissionCeilings,
  type PublisherAdmissionDecision,
  type PublisherAdmissionDimension,
  type PublisherAdmissionRequest,
  type PublisherCeilingConfiguration,
  type PublisherIdentity,
  type PublisherIdentityKind,
  type PublisherOperationKind,
  type PublisherWriteGrant,
  type SubscriptionLimitDecision,
  type SubscriptionLimitDimension,
  type SubscriptionLimitRequest,
  type SubscriptionLimitValues,
} from './operation-cost.js';

export {
  assertEpochMilliseconds,
  assertUnixSeconds,
  type EpochMilliseconds,
  type NumericDateSeconds,
  type UnixSeconds,
} from './time-units.js';

export {
  enforceCredentialRestrictions,
  type CredentialClockPort,
  type CredentialIpAllowlistEntry,
  type CredentialIpSubnet,
  type CredentialNodeSubtree,
  type CredentialNodeSubtreeCheck,
  type CredentialNodeSubtreePort,
  type CredentialOperationBudgetPort,
  type CredentialOperationCharge,
  type CredentialRestriction,
  type CredentialRestrictionDecision,
  type CredentialRestrictionDenialReason,
  type CredentialRestrictionPorts,
  type CredentialRestrictionRequest,
} from './credential-restrictions.js';

export {
  CREDENTIAL_QUERY_PARAMETER_NAMES,
  CREDENTIAL_QUERY_PARAMETER_NAME_SET,
  type CredentialQueryParameterName,
} from './credential-query-names.js';

export {
  enforceApiKeyTransport,
  enforceApiKeyOnlyTransport,
  type ApiKeyClassifier,
  type ApiKeyTransportDecision,
  type ApiKeyTransportDenialReason,
  type ApiKeyTransportInput,
} from './api-key-transport.js';

export {
  OAUTH_ACCESS_TOKEN_TTL_CEILING_SECONDS,
  enforceOAuth21Profile,
  type OAuth21Integration,
  type OAuth21ProfileApplicability,
  type OAuth21ProfileDecision,
  type OAuth21ProfileDenialReason,
  type OAuth21ProfileInput,
  type OAuth21ProfilePorts,
  type OAuthAccessTokenEvidence,
  type OAuthAuthorizationServerDiscovery,
  type OAuthAuthorizationServerDiscoveryMethod,
  type OAuthAuthorizationServerProvenanceCheck,
  type OAuthAuthorizationServerProvenancePort,
  type OAuthBearerTransportEvidence,
  type OAuthClientEvidence,
  type OAuthOutboundTokenEvidence,
  type OAuthPkceEvidence,
  type OAuthProtectedResourceMetadata,
  type OAuthRefreshTokenEvidence,
  type OAuthResourceIndicatorRequest,
  type OAuthTokenFlowEvidence,
  type OAuthUpstreamTokenEvidence,
} from './oauth-profile.js';

export {
  DPOP_PROOF_MAX_AGE_SECONDS,
  enforceSenderConstraint,
  type DpopProofVerification,
  type DpopProofVerificationCheck,
  type DpopProofVerificationPort,
  type DpopReplayConsumptionCheck,
  type DpopReplayPort,
  type DpopRequestEvidence,
  type MtlsSenderConstraintEvidence,
  type SenderConstraintAccessTokenEvidence,
  type SenderConstraintApplicability,
  type SenderConstraintClockPort,
  type SenderConstraintDecision,
  type SenderConstraintDenialReason,
  type SenderConstraintInput,
  type SenderConstraintLocation,
  type SenderConstraintMode,
  type SenderConstraintOperation,
  type SenderConstraintPorts,
  type SenderConstraintTokenConfirmation,
} from './sender-constraint.js';

/**
 * HTTPS decision types for composition return values.
 * The atomic function `enforceHttpsEndpoint` and its input
 * (`HttpsEndpointInput`) stay off this barrel so hosts cannot self-assert
 * `remote: false` and skip transport evidence.
 */
export {
  type HttpsEndpointApplicability,
  type HttpsEndpointDecision,
  type HttpsEndpointDenialReason,
  type HttpsEndpointLocation,
} from './https-enforcement.js';

export {
  type OriginGuardApplicability,
  type OriginGuardDecision,
  type OriginGuardDenialReason,
  type OriginGuardInput,
} from './origin-guard.js';

/**
 * Official request-boundary composition (H-1 wiring / M-1 remote trust).
 * Handlers must not call atomic HTTPS/Origin guards with self-asserted
 * `remote: false`; they should supply {@link TrustedTransportEvidence}
 * derived by the deployment/framework and use these helpers.
 */
export {
  deriveRemoteApplicability,
  enforceHttpsFromTransport,
  enforceOriginFromTransport,
  enforcePublisherStreamableHttpBoundary,
  type BoundaryNetworkExposure,
  type BoundaryProtocol,
  type BoundaryTransportScheme,
  type PublisherBoundaryDenialReason,
  type PublisherStreamableHttpBoundaryDecision,
  type PublisherStreamableHttpBoundaryOptions,
  type RemoteApplicability,
  type TrustedTransportEvidence,
} from './request-boundary.js';

export {
  emitContentIntegrityHeaders,
  serializeContentIntegrity,
  type ContentIntegrityDecision,
  type ContentIntegrityDenialReason,
  type ContentIntegrityInput,
  type ContentIntegrityKeySource,
  type ContentIntegrityResourceType,
  type ContentIntegrityRotationEvidence,
  type ContentIntegrityVisibility,
} from './content-integrity.js';

export {
  MAX_MUTABLE_STALE_SECONDS,
  MUTABLE_INTEGRITY_COMPONENTS,
  enforceMutableIntegrity,
  enforceMutableResourceIntegrity,
  verifyMutableResourceIntegrity,
  type MutableIntegrityClaims,
  type MutableIntegrityClockPort,
  type MutableIntegrityDecision,
  type MutableIntegrityDenialReason,
  type MutableIntegrityInput,
  type MutableIntegrityPorts,
  type MutableIntegrityResourceType,
  type MutableIntegritySignatureVerificationPort,
} from './mutable-integrity.js';
export {
  OAUTH_CLIENT_SECURITY_REASON_CODES,
  OAUTH_SECRET_REDACTION,
  buildOAuthDcrClientMetadata,
  canonicalOAuthIssuer,
  classifyOAuthClientApplicability,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthCredentialIssuerIsolation,
  enforceOAuthDcrApplicationType,
  enforceOAuthPkce,
  enforceOAuthRedirectUri,
  enforceOAuthTokenExchangeIssuer,
  formatOAuthLogContext,
  oauthCredentialStoreKey,
  redactOAuthCredential,
  resolveOAuthApplicationType,
  rotateOAuthRefreshToken,
  selectOAuthClientCredentialForIssuer,
  selectOAuthRefreshStateForIssuer,
  type OAuthAuthorizationResponseIssDecision,
  type OAuthAuthorizationResponseIssDenialReason,
  type OAuthAuthorizationResponseIssInput,
  type OAuthAuthorizationServerMetadataDecision,
  type OAuthAuthorizationServerMetadataDenialReason,
  type OAuthAuthorizationServerMetadataOptions,
  type OAuthAuthorizationServerMetadataSnapshot,
  type OAuthClientApplicabilityDecision,
  type OAuthClientCredentialVaultPort,
  type OAuthClientMetadataDocument,
  type OAuthClientDeploymentType,
  type OAuthClientHostKind,
  type OAuthClientNotApplicableReason,
  type OAuthClientTokenStorePort,
  type OAuthStoredClientCredentials,
  type OAuthStoredTokens,
  type OAuthCredentialIssuerIsolationDecision,
  type OAuthCredentialIssuerIsolationDenialReason,
  type OAuthDcrApplicationTypeDecision,
  type OAuthDcrApplicationTypeDenialReason,
  type OAuthDcrClientMetadataInput,
  type OAuthIssuerKeyedClientCredential,
  type OAuthIssuerKeyedRefreshState,
  type OAuthLogOperation,
  type OAuthLogSafeContext,
  type OAuthPkceDecision,
  type OAuthPkceDenialReason,
  type OAuthPkceInput,
  type OAuthRedirectUriDecision,
  type OAuthRedirectUriDenialReason,
  type OAuthRefreshRotationDecision,
  type OAuthRefreshRotationDenialReason,
  type OAuthTokenExchangeIssuerDecision,
  type OAuthTokenExchangeIssuerDenialReason,
  type OAuthTokenExchangeIssuerInput,
} from './mcp-oauth-client.js';
