import type { AppConfig } from '../../bootstrap/config.js';
import type {
  AccountDeletionService,
  AccountLinkingService,
  AccountRecoveryService,
  BrowserSessionAuthority,
} from '../../modules/auth/index.js';
import type {
  AvatarObjectStore,
  IdentityUnitOfWork,
  OidcClaimSyncMetrics,
} from '../../modules/identity/index.js';
import type { PublicObjectRateLimiter } from '../product/public-object-rate-limit.js';
import type { OidcProviderPort } from './oidc-provider.js';

export interface BrowserAuthDeps {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly oidcProvider?: OidcProviderPort;
  /** Optional sanitized counter sink for discarded OIDC claims (FIX-M-003). */
  readonly metrics?: OidcClaimSyncMetrics;
  /** Optional public avatar object store. When absent avatar routes are not registered. */
  readonly avatarStore?: AvatarObjectStore;
  /** Origin check for restrict_publication on the owning account. */
  readonly avatarPublicAccess?: { isPublicationRestricted(objectId: string): Promise<boolean> };
  /**
   * C3 explicit account-linking facade. When present the product link
   * start/unlink routes are registered (session + Origin/CSRF + re-auth);
   * absent keeps the surface closed (no link/unlink endpoints).
   */
  readonly accountLinking?: AccountLinkingService;
  /**
   * C3 recovery facade. When present the product recovery routes are
   * registered (non-enumerating reset request + verified-email OTP reset);
   * absent keeps the surface closed.
   */
  readonly accountRecovery?: AccountRecoveryService;
  /**
   * P10 account deletion facade. When present the product delete route is
   * registered (session + Origin/CSRF + re-auth + typed confirmation);
   * absent keeps the surface closed.
   */
  readonly accountDeletion?: AccountDeletionService;
  /**
   * A3 BrowserSessionAuthority. When present the session/me/logout routes
   * authenticate through Better Auth + known_auth_session_metadata; when
   * absent the legacy OIDC product session state machine serves (G1 §5).
   */
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  /**
   * Optional in-process limiter for public GET /api/v1/avatar/:avatarId.
   * Defaults to a per-process `public-object` family. Not the auth `me`
   * family used by POST /api/v1/me/avatar. AUTH_API_REPLICAS>1 does not
   * share this budget across origin replicas.
   */
  readonly publicObjectRateLimiter?: PublicObjectRateLimiter;
}
