import type { Kysely } from 'kysely';
import type { AppConfig } from './config.js';
import type { DatabaseSchema } from '../infrastructure/database/runtime.js';
import {
  createBetterAuthRuntime,
  type BetterAuthInstance,
  type BetterAuthRuntime,
  type BetterAuthRuntimeInput,
} from '../infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresBusinessAccountUnitOfWork } from '../infrastructure/auth/business-account-unit-of-work.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../modules/auth/better-auth-config.js';
import {
  createAccountSecurityEventNotification,
  createOAuthOccupancyAdoptedHandler,
  createProviderLinkEpochHandler,
  createSecurityEpochBridge,
  type AuthEmailSender,
  type BrowserSessionAuthority,
  type OAuthOccupancyAdoptedInput,
  type SecurityEpochBridge,
} from '../modules/auth/index.js';
import type { McpOauthRevocationStore } from '../modules/mcp/index.js';
import type { ApplicationModule } from '../modules/index.js';

export interface ModuleComposition {
  readonly modules: readonly ApplicationModule[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function composeModules(modules: readonly ApplicationModule[] = []): ModuleComposition {
  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.name)) throw new Error(`duplicate module name: ${module.name}`);
    names.add(module.name);
  }
  const started: ApplicationModule[] = [];

  async function stopStarted(): Promise<void> {
    const failures: unknown[] = [];
    for (const module of [...started].reverse()) {
      try {
        await module.stop();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    started.length = 0;
    if (failures.length > 0) throw new AggregateError(failures, 'one or more modules failed to stop');
  }

  return {
    modules: [...modules],
    async start() {
      if (started.length > 0) throw new Error('module composition is already started');
      try {
        for (const module of modules) {
          await module.start();
          started.push(module);
        }
      } catch (startError: unknown) {
        try {
          await stopStarted();
        } catch (stopError: unknown) {
          throw new AggregateError([startError, stopError], 'module startup and rollback failed');
        }
        throw startError;
      }
    },
    stop: stopStarted,
  };
}

export interface BetterAuthCompositionInput {
  readonly config: AppConfig;
  readonly db: Kysely<DatabaseSchema>;
  /** C1 auth email sender (composed by startApi; test-mode sink or DirectMail). */
  readonly authEmail: AuthEmailSender;
  /** Minimal pino-compatible logger for redacted establishment warnings. */
  readonly logger: {
    warn(bindings: object, message: string): void;
    info?(bindings: object, message: string): void;
  };
  /**
   * When present, account events notify after revokeAll. The verifier reads
   * the account epoch row from that transaction. Absent: do not treat this
   * deployment as revoking external MCP credentials.
   */
  readonly mcpOauthRevocationStore?: McpOauthRevocationStore;
  /**
   * NODE_ENV=test only: forwarded into `createBetterAuthRuntime` so occupancy
   * / linking integration can mount a controlled genericOAuth plugin without
   * copying the production occupancy holder. Production must not pass this.
   */
  readonly testGenericOAuth?: BetterAuthRuntimeInput<never>['testGenericOAuth'];
  /**
   * NODE_ENV=test only: forwarded into `createBetterAuthRuntime` so CIMD e2e
   * can serve metadata for a public-looking HTTPS `client_id` without opening
   * SSRF. Production must not pass this.
   */
  readonly testFetchClientMetadataResource?: BetterAuthRuntimeInput<never>['testFetchClientMetadataResource'];
  /** Optional sealed DCR admission/reclaim counters (production InMemoryMetrics). */
  readonly metrics?: Metrics;
}

export interface BetterAuthComposition {
  readonly browserSessionAuthority?: BrowserSessionAuthority;
  readonly betterAuthRuntime?: BetterAuthRuntime;
  readonly securityEpochBridge?: SecurityEpochBridge;
  /**
   * AUTH-P1-a: the shared Better Auth instance (same object as
   * `betterAuthRuntime.auth`). C3 recovery/link/delete must use this
   * `auth.api` so password-reset and occupancy hooks fire.
   */
  readonly betterAuth?: BetterAuthInstance;
}

/**
 * F2 (plan §12 Task F2): Better Auth production composition.
 *
 * When BETTER_AUTH_ENABLED=true this constructs the REAL Better Auth 1.7.1
 * instance (Argon2id hook, digest-only OTP, C1 auth email sender, A2
 * business-account establishment), the A3 browser session authority over the
 * real `auth.api` + PostgreSQL, and the C4 security-epoch bridge with the MCP
 * OAuth propagation port. Disabled mode constructs NONE of them (A1
 * zero-registration contract) and returns an empty composition, so the legacy
 * OIDC chain keeps serving exactly as before. Construction is side-effect
 * free (no network, no DB queries); the legacy OIDC provider/discovery are
 * never touched here.
 */
export function composeBetterAuthComposition(
  input: BetterAuthCompositionInput,
): BetterAuthComposition {
  if (!input.config.betterAuth.enabled) return {};
  const built = buildBetterAuthConfig(input.config.betterAuth);
  if (built === null) {
    throw new Error('API composition refused: BETTER_AUTH_ENABLED=true must produce Better Auth settings');
  }
  const occupancyAdopted: {
    current: ((input: OAuthOccupancyAdoptedInput) => Promise<void>) | null;
  } = { current: null };
  const providerLinked: {
    current: ((event: { readonly authUserId: string }) => Promise<void>) | null;
  } = { current: null };
  const businessUnitOfWork = createPostgresBusinessAccountUnitOfWork(input.db);
  const runtimeInput = {
    enabled: true,
    config: built,
    database: { db: input.db, type: 'postgres' as const, transaction: true as const },
    authEmail: input.authEmail,
    businessAccount: { unitOfWork: businessUnitOfWork },
    logger: input.logger,
    onOAuthOccupancyAdopted: async (event: OAuthOccupancyAdoptedInput) => {
      // Fail closed: a missing holder must not complete adopt while the
      // squatter password remains (S-01). Optional-chaining would skip revokeAll.
      const handler = occupancyAdopted.current;
      if (handler === null) {
        throw new Error('oauth occupancy adopt requires session revoke wiring');
      }
      await handler(event);
    },
    onProviderLinked: async (event: { readonly authUserId: string }) => {
      const handler = providerLinked.current;
      if (handler === null) {
        throw new Error('provider link requires session revoke wiring');
      }
      await handler(event);
    },
    ...(input.testGenericOAuth === undefined ? {} : { testGenericOAuth: input.testGenericOAuth }),
    ...(input.testFetchClientMetadataResource === undefined
      ? {}
      : { testFetchClientMetadataResource: input.testFetchClientMetadataResource }),
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
  };
  // AUTH-P1-a: one Better Auth instance for mount, session authority, and
  // C3 auth.api. Late-bound holders attach epoch/occupancy after the
  // authority exists; the instance is constructed once inside the runtime.
  const runtime = createBetterAuthRuntime(runtimeInput);
  if (runtime === null) {
    throw new Error('API composition refused: BETTER_AUTH_ENABLED=true must construct the Better Auth runtime');
  }
  const authority = createBetterAuthSessionAuthority({
    db: input.db,
    betterAuth: createBetterAuthServerApi(runtime.auth),
    secret: built.secret,
    sessionExpiresInSeconds: built.sessionExpiresInSeconds,
    sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
  });
  // Password changes revoke in auth_accounts' database transaction. BA creates
  // the retained successor afterwards, whose metadata reads the committed epoch.
  // A post-response callback must neither double-bump nor revoke that successor.
  const securityEpochBridge = createSecurityEpochBridge({
    authority,
    ...(input.mcpOauthRevocationStore === undefined
      ? {}
      : { propagation: createAccountSecurityEventNotification(input.logger) }),
  });
  occupancyAdopted.current = createOAuthOccupancyAdoptedHandler({
    businessAccount: businessUnitOfWork,
    securityEpochBridge,
  });
  providerLinked.current = createProviderLinkEpochHandler({
    businessAccount: businessUnitOfWork,
    securityEpochBridge,
  });
  return {
    browserSessionAuthority: authority,
    betterAuthRuntime: runtime,
    securityEpochBridge,
    betterAuth: runtime.auth,
  };
}

export {
  composePublicProfileProjection,
  getPublicProfileProjection,
  PublicProfileCursorError,
  PublicProfileNotFoundError,
  type PublicProfileProjection,
  type PublicProfileProjectionInput,
  type PublicProfileProjectionPorts,
} from './public-profile-projection.js';
