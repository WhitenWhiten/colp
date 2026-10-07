import { loadConfig } from './config.js';
import {
  AliyunDirectMailAdapter,
  composeAuthEmailAdapter,
  createInProcessMailboxSink,
  type AuthEmailComposition,
  type InProcessMailboxSink,
} from '../infrastructure/email/index.js';
import {
  createPostgresEmailDeliveryWorkerRepository,
  createPostgresEmailSuppressionOpsRepository,
} from '../infrastructure/email/index.js';
import {
  createMemoryEmailCallbackRateLimiter,
  createRedisEmailCallbackRateLimiter,
} from '../infrastructure/rate-limit/index.js';
import { createFixedWindowRateLimiter } from '../transport/http-security.js';
import { reconcileEmailCallback, type EmailCallbackFact, type EmailCallbackRateLimiter,
  type EmailProviderAdapter } from '../modules/email/index.js';
import type { DatabaseRuntime } from '../infrastructure/database/index.js';
import { createLogger, type Metrics } from '../infrastructure/telemetry/index.js';

export interface ApiEmailComposition {
  readonly authMailboxSink: InProcessMailboxSink | undefined;
  readonly authEmailComposition: AuthEmailComposition;
  readonly emailCallbackRoutes: {
    readonly enabled: boolean;
    readonly verifier: EmailProviderAdapter;
    readonly reconcile: (fact: EmailCallbackFact) => ReturnType<typeof reconcileEmailCallback>;
    readonly metrics: Metrics;
    readonly rateLimiter: EmailCallbackRateLimiter;
  } | undefined;
  readonly emailOpsRoutes: {
    readonly enabled: boolean;
    readonly opsToken: string | null;
    readonly repository: ReturnType<typeof createPostgresEmailSuppressionOpsRepository>;
    readonly metrics: Metrics;
    readonly rateLimiter?: ReturnType<typeof createFixedWindowRateLimiter>;
  };
  readonly emailProvider: EmailProviderAdapter | undefined;
  readonly emailCallbackRateLimiter: EmailCallbackRateLimiter | undefined;
}

export function composeApiEmail(input: {
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: DatabaseRuntime;
  readonly metrics: Metrics;
  readonly metricsLogger: ReturnType<typeof createLogger>;
}): ApiEmailComposition {
  const { config, database, metrics, metricsLogger } = input;
  // C1 auth email surface (plan §9 Task C1): composed ALWAYS so the auth
  // routes hold a stable sender — the unavailable sender when
  // AUTH_EMAIL_ENABLED=false (never claims a real mailbox send), the
  // in-process mailbox sink in test mode (never DirectMail credentials), and
  // the DirectMail adapter in any other environment (credentials fail closed).
  // C2 wires this sender into the Better Auth email flows; lifecycle is owned
  // here (startup-error path and app onClose).
  // E3 test-only mailbox surface: when KNOWN_AUTH_MAILBOX_HTTP=true the sink
  // is created HERE (not inside the composition) so the harness-facing route
  // below can read the same entries the auth routes deliver. Test material
  // only; the sink never resolves DirectMail credentials (test-mode branch).
  const authMailboxSink: InProcessMailboxSink | undefined = config.testAuthMailboxHttp.enabled
    ? createInProcessMailboxSink()
    : undefined;
  const authEmailComposition: AuthEmailComposition = composeAuthEmailAdapter({
    enabled: config.authEmail.enabled,
    nodeEnv: config.nodeEnv,
    directMail: config.authEmail,
    ...(authMailboxSink === undefined ? {} : { inProcessSink: authMailboxSink }),
    resolveCredentials: () => {
      const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
      const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
      if (!accessKeyId || !accessKeySecret) {
        throw new Error(
          'API composition refused: AUTH_EMAIL_ENABLED requires '
          + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET',
        );
      }
      return { accessKeyId, accessKeySecret };
    },
    logger: metricsLogger,
    emailSkins: config.emailSkins,
  });
  const emailSuppressionOpsRepository = createPostgresEmailSuppressionOpsRepository(database.pool);
  // P5-31 callback ingress: composed ONLY when the optional email feature is
  // enabled (fail closed on missing provider credentials, matching worker
  // composition). The surface itself is additionally disabled (404) when the
  // EventBridge/controlled-sink HMAC secret is unconfigured, so an unverified
  // ingress is never open. The ops suppression surface uses EMAIL_OPS_TOKEN
  // and is disabled (404) when the token is unset.
  let emailProvider: EmailProviderAdapter | undefined;
  // FIX-L-061: the callback ingress owns one trusted-IP limiter (memory by
  // default; shared Redis adapter when EMAIL_CALLBACK_RATE_LIMIT_SHARED=true,
  // so N replicas share one per-IP quota). The route consumes the budget
  // before any signature verification / certificate fetch; the composition
  // closes it on the startup-error path and on app close.
  let emailCallbackRateLimiter: EmailCallbackRateLimiter | undefined;
  const emailCallbackRoutes = config.email?.enabled === true
    ? (() => {
        const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
        const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
        if (!accessKeyId || !accessKeySecret) {
          throw new Error('API composition refused: KNOWN_FEATURE_EMAIL enabled requires '
            + 'ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET');
        }
        emailProvider = new AliyunDirectMailAdapter({
          endpoint: config.email!.endpoint,
          regionId: config.email!.regionId,
          accountName: config.email!.accountName!,
          accessKeyId,
          accessKeySecret,
          timeoutMs: config.email!.timeoutMs,
          tagPrefix: config.email!.tagPrefix,
          maxTagChars: config.email!.maxTagChars,
          ...(config.email!.callback.hmacSecret !== null
            ? { callbackHmacSecret: config.email!.callback.hmacSecret } : {}),
          callbackTimestampReplayWindowMs: config.email!.callback.timestampReplayWindowMs,
        });
        const repository = createPostgresEmailDeliveryWorkerRepository(database.pool);
        const shared = config.email!.callbackRateLimitShared;
        if (shared.enabled) {
          if (shared.redisUrl === null || shared.keySecret === null) {
            throw new Error(
              'API composition refused: EMAIL_CALLBACK_RATE_LIMIT_SHARED=true requires '
              + 'EMAIL_CALLBACK_RATE_LIMIT_REDIS_URL and EMAIL_CALLBACK_RATE_LIMIT_KEY_SECRET',
            );
          }
          emailCallbackRateLimiter = createRedisEmailCallbackRateLimiter({
            redisUrl: shared.redisUrl,
            environment: config.nodeEnv,
            keySecret: shared.keySecret,
            keyPrefix: shared.keyPrefix,
            ip: config.email!.callbackRateLimit,
            commandTimeoutMs: shared.commandTimeoutMs,
            connectTimeoutMs: shared.connectTimeoutMs,
            maxRetriesPerRequest: shared.maxRetriesPerRequest,
          });
        } else {
          emailCallbackRateLimiter = createMemoryEmailCallbackRateLimiter({
            ip: config.email!.callbackRateLimit,
          });
        }
        return {
          enabled: config.email!.callback.hmacSecret !== null,
          verifier: emailProvider,
          reconcile: (fact: EmailCallbackFact) => reconcileEmailCallback({
            fact,
            repository,
            tagPrefix: config.email!.tagPrefix,
          }),
          metrics,
          rateLimiter: emailCallbackRateLimiter,
        };
      })()
    : undefined;
  const emailOpsRoutes = {
    enabled: config.email?.enabled === true && config.email?.opsToken != null,
    opsToken: config.email?.opsToken ?? null,
    repository: emailSuppressionOpsRepository,
    metrics,
    // B2: bounded per-IP brute-force protection for the ops suppression
    // surface, driven by EMAIL_OPS_RATE_LIMIT_MAX/EMAIL_OPS_RATE_LIMIT_WINDOW_MS.
    ...(config.email ? { rateLimiter: createFixedWindowRateLimiter(config.email.opsRateLimit) } : {}),
  };
  return {
    authMailboxSink,
    authEmailComposition,
    emailCallbackRoutes,
    emailOpsRoutes,
    emailProvider,
    emailCallbackRateLimiter,
  };
}
