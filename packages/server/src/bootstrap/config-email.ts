import { parsePositiveInt } from './config-parse-helpers.js';
import type {
  AuthEmailFeatureConfig,
  CollaborationInviteEmailConfig,
  EmailDeliveryWorkerConfig,
  EmailFeatureConfig,
  EmailFeatureConfigSanitized,
} from './config-types.js';

export type EmailFeatureConfigWithoutShared = Omit<EmailFeatureConfig, 'callbackRateLimitShared'>;

const DEFAULT_EMAIL_DM_ENDPOINT = 'https://dm.aliyuncs.com/';
const DEFAULT_EMAIL_DM_REGION_ID = 'cn-hangzhou';
const DEFAULT_EMAIL_DM_TIMEOUT_MS = 10_000;
const DEFAULT_EMAIL_DM_TAG_PREFIX = 'known-delivery-';
const DEFAULT_EMAIL_DM_MAX_TAG_CHARS = 128;
const DEFAULT_EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS = 300_000;
const DEFAULT_AUTH_EMAIL_DM_ENDPOINT = 'https://dm.aliyuncs.com/';
const DEFAULT_AUTH_EMAIL_DM_REGION_ID = 'cn-hangzhou';
const DEFAULT_AUTH_EMAIL_DM_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_EMAIL_DM_TAG_PREFIX = 'known-auth-';
const DEFAULT_AUTH_EMAIL_DM_MAX_TAG_CHARS = 128;
const DEFAULT_COLLABORATION_INVITE_EMAIL_DM_TAG_PREFIX = 'known-invite-';
const DEFAULT_EMAIL_DELIVERY_MAX_ATTEMPTS = 6;
const DEFAULT_EMAIL_DELIVERY_BASE_BACKOFF_MS = 60_000;
const DEFAULT_EMAIL_DELIVERY_MAX_BACKOFF_MS = 3_600_000;
const DEFAULT_EMAIL_DELIVERY_POLL_INTERVAL_MS = 1_000;
const DEFAULT_EMAIL_DELIVERY_LEASE_DURATION_MS = 30_000;
const DEFAULT_EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_EMAIL_DELIVERY_BATCH_SIZE = 8;

export function sanitizeEmailFeatureConfig(config: EmailFeatureConfig): EmailFeatureConfigSanitized {
  return Object.freeze({
    enabled: config.enabled,
    endpoint: config.endpoint,
    regionId: config.regionId,
    timeoutMs: config.timeoutMs,
    tagPrefix: config.tagPrefix,
    maxTagChars: config.maxTagChars,
    callbackTimestampReplayWindowMs: config.callback.timestampReplayWindowMs,
    worker: Object.freeze({
      maxAttempts: config.worker.maxAttempts,
      baseBackoffMs: config.worker.baseBackoffMs,
      maxBackoffMs: config.worker.maxBackoffMs,
      pollIntervalMs: config.worker.pollIntervalMs,
      leaseDurationMs: config.worker.leaseDurationMs,
      heartbeatIntervalMs: config.worker.heartbeatIntervalMs,
      batchSize: config.worker.batchSize,
    }),
  });
}

export function loadAuthEmailFeatureConfig(env: NodeJS.ProcessEnv): AuthEmailFeatureConfig {
  const authEmailFlag = (env.AUTH_EMAIL_ENABLED ?? 'false').trim().toLowerCase();
  if (authEmailFlag !== 'true' && authEmailFlag !== 'false') {
    throw new Error('AUTH_EMAIL_ENABLED must be true or false');
  }
  let authEmailEndpointUrl: URL;
  try {
    authEmailEndpointUrl = new URL(env.AUTH_EMAIL_DM_ENDPOINT?.trim() ?? DEFAULT_AUTH_EMAIL_DM_ENDPOINT);
    if (authEmailEndpointUrl.protocol !== 'https:' || authEmailEndpointUrl.username
        || authEmailEndpointUrl.password || authEmailEndpointUrl.search || authEmailEndpointUrl.hash) {
      throw new Error();
    }
  } catch {
    throw new Error('AUTH_EMAIL_DM_ENDPOINT must be a clean absolute https URL without userinfo, query or fragment');
  }
  const authEmailEndpoint = authEmailEndpointUrl.href;
  const authEmailRegionId = env.AUTH_EMAIL_DM_REGION_ID?.trim() ?? DEFAULT_AUTH_EMAIL_DM_REGION_ID;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]+){1,4}$/u.test(authEmailRegionId)) {
    throw new Error('AUTH_EMAIL_DM_REGION_ID must be an Aliyun region id like cn-hangzhou');
  }
  const authEmailAccountName = env.AUTH_EMAIL_DM_ACCOUNT_NAME?.trim() || null;
  const authEmailTimeoutMs = parsePositiveInt(env.AUTH_EMAIL_DM_TIMEOUT_MS,
    DEFAULT_AUTH_EMAIL_DM_TIMEOUT_MS, 'AUTH_EMAIL_DM_TIMEOUT_MS', { min: 500, max: 60_000 });
  const authEmailTagPrefix = env.AUTH_EMAIL_DM_TAG_PREFIX?.trim() ?? DEFAULT_AUTH_EMAIL_DM_TAG_PREFIX;
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(authEmailTagPrefix)) {
    throw new Error('AUTH_EMAIL_DM_TAG_PREFIX must match [A-Za-z0-9_-]{1,32}');
  }
  const authEmailMaxTagChars = parsePositiveInt(env.AUTH_EMAIL_DM_MAX_TAG_CHARS,
    DEFAULT_AUTH_EMAIL_DM_MAX_TAG_CHARS, 'AUTH_EMAIL_DM_MAX_TAG_CHARS', { min: 16, max: 128 });
  if (authEmailFlag === 'true' && !authEmailAccountName) {
    throw new Error('AUTH_EMAIL_DM_ACCOUNT_NAME is required when AUTH_EMAIL_ENABLED is enabled');
  }
  return Object.freeze({
    enabled: authEmailFlag === 'true',
    endpoint: authEmailEndpoint,
    regionId: authEmailRegionId,
    accountName: authEmailAccountName,
    timeoutMs: authEmailTimeoutMs,
    tagPrefix: authEmailTagPrefix,
    maxTagChars: authEmailMaxTagChars,
  });
}

export function loadCollaborationInviteEmailConfig(
  env: NodeJS.ProcessEnv,
  args: {
    readonly nodeEnv: string;
    readonly authEmail: AuthEmailFeatureConfig;
  },
): CollaborationInviteEmailConfig {
  const { nodeEnv, authEmail } = args;
  const collaborationInviteEmailFlag = (env.COLLABORATION_INVITE_EMAIL_ENABLED ?? 'false').trim().toLowerCase();
  if (collaborationInviteEmailFlag !== 'true' && collaborationInviteEmailFlag !== 'false') {
    throw new Error('COLLABORATION_INVITE_EMAIL_ENABLED must be true or false');
  }
  const collaborationInviteEmailAccountName = env.COLLABORATION_INVITE_EMAIL_DM_ACCOUNT_NAME?.trim()
    || authEmail.accountName;
  const collaborationInviteEmailTagPrefix = env.COLLABORATION_INVITE_EMAIL_DM_TAG_PREFIX?.trim()
    ?? DEFAULT_COLLABORATION_INVITE_EMAIL_DM_TAG_PREFIX;
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(collaborationInviteEmailTagPrefix)) {
    throw new Error('COLLABORATION_INVITE_EMAIL_DM_TAG_PREFIX must match [A-Za-z0-9_-]{1,32}');
  }
  if (collaborationInviteEmailFlag === 'true' && nodeEnv !== 'test' && !collaborationInviteEmailAccountName) {
    throw new Error(
      'COLLABORATION_INVITE_EMAIL_DM_ACCOUNT_NAME or AUTH_EMAIL_DM_ACCOUNT_NAME is required '
      + 'when COLLABORATION_INVITE_EMAIL_ENABLED is enabled',
    );
  }
  return Object.freeze({
    enabled: collaborationInviteEmailFlag === 'true',
    endpoint: authEmail.endpoint,
    regionId: authEmail.regionId,
    accountName: collaborationInviteEmailAccountName,
    timeoutMs: authEmail.timeoutMs,
    tagPrefix: collaborationInviteEmailTagPrefix,
    maxTagChars: authEmail.maxTagChars,
  });
}

export function loadEmailFeatureConfig(
  env: NodeJS.ProcessEnv,
  emailFlag: string,
): EmailFeatureConfigWithoutShared {
  let emailEndpointUrl: URL;
  try {
    emailEndpointUrl = new URL(env.EMAIL_DM_ENDPOINT?.trim() ?? DEFAULT_EMAIL_DM_ENDPOINT);
    if (emailEndpointUrl.protocol !== 'https:' || emailEndpointUrl.username || emailEndpointUrl.password
        || emailEndpointUrl.search || emailEndpointUrl.hash) {
      throw new Error();
    }
  } catch {
    throw new Error('EMAIL_DM_ENDPOINT must be a clean absolute https URL without userinfo, query or fragment');
  }
  const emailEndpoint = emailEndpointUrl.href;
  const emailRegionId = env.EMAIL_DM_REGION_ID?.trim() ?? DEFAULT_EMAIL_DM_REGION_ID;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]+){1,4}$/u.test(emailRegionId)) {
    throw new Error('EMAIL_DM_REGION_ID must be an Aliyun region id like cn-hangzhou');
  }
  const emailAccountName = env.EMAIL_DM_ACCOUNT_NAME?.trim() || null;
  const emailTimeoutMs = parsePositiveInt(env.EMAIL_DM_TIMEOUT_MS,
    DEFAULT_EMAIL_DM_TIMEOUT_MS, 'EMAIL_DM_TIMEOUT_MS', { min: 500, max: 60_000 });
  const emailTagPrefix = env.EMAIL_DM_TAG_PREFIX?.trim() ?? DEFAULT_EMAIL_DM_TAG_PREFIX;
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(emailTagPrefix)) {
    throw new Error('EMAIL_DM_TAG_PREFIX must match [A-Za-z0-9_-]{1,32}');
  }
  const emailMaxTagChars = parsePositiveInt(env.EMAIL_DM_MAX_TAG_CHARS,
    DEFAULT_EMAIL_DM_MAX_TAG_CHARS, 'EMAIL_DM_MAX_TAG_CHARS', { min: 16, max: 128 });
  const emailCallbackHmacSecret = env.EMAIL_DM_CALLBACK_HMAC_SECRET?.trim() || null;
  const emailCallbackTimestampWindowMs = parsePositiveInt(
    env.EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS,
    DEFAULT_EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS,
    'EMAIL_DM_CALLBACK_TIMESTAMP_WINDOW_MS',
    { min: 1_000, max: 600_000 },
  );
  const emailOpsToken = env.EMAIL_OPS_TOKEN?.trim() || null;
  if (emailOpsToken !== null && emailOpsToken.length < 32) {
    throw new Error('EMAIL_OPS_TOKEN must be at least 32 characters');
  }
  const emailOpsRateLimitMax = parsePositiveInt(env.EMAIL_OPS_RATE_LIMIT_MAX, 60,
    'EMAIL_OPS_RATE_LIMIT_MAX', { max: 10_000 });
  const emailOpsRateLimitWindowMs = parsePositiveInt(env.EMAIL_OPS_RATE_LIMIT_WINDOW_MS,
    60_000, 'EMAIL_OPS_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 });
  const emailCallbackRateLimitMax = parsePositiveInt(env.EMAIL_CALLBACK_RATE_LIMIT_MAX, 600,
    'EMAIL_CALLBACK_RATE_LIMIT_MAX', { max: 10_000 });
  const emailCallbackRateLimitWindowMs = parsePositiveInt(env.EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MS,
    60_000, 'EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MS', { max: 3_600_000 });
  const emailDeliveryMaxAttempts = parsePositiveInt(env.EMAIL_DELIVERY_MAX_ATTEMPTS,
    DEFAULT_EMAIL_DELIVERY_MAX_ATTEMPTS, 'EMAIL_DELIVERY_MAX_ATTEMPTS', { min: 2, max: 20 });
  const emailDeliveryBaseBackoffMs = parsePositiveInt(env.EMAIL_DELIVERY_BASE_BACKOFF_MS,
    DEFAULT_EMAIL_DELIVERY_BASE_BACKOFF_MS, 'EMAIL_DELIVERY_BASE_BACKOFF_MS',
    { min: 1_000, max: 3_600_000 });
  const emailDeliveryMaxBackoffMs = parsePositiveInt(env.EMAIL_DELIVERY_MAX_BACKOFF_MS,
    DEFAULT_EMAIL_DELIVERY_MAX_BACKOFF_MS, 'EMAIL_DELIVERY_MAX_BACKOFF_MS',
    { min: emailDeliveryBaseBackoffMs, max: 86_400_000 });
  const emailDeliveryPollIntervalMs = parsePositiveInt(env.EMAIL_DELIVERY_POLL_INTERVAL_MS,
    DEFAULT_EMAIL_DELIVERY_POLL_INTERVAL_MS, 'EMAIL_DELIVERY_POLL_INTERVAL_MS',
    { min: 100, max: 60_000 });
  const emailDeliveryLeaseDurationMs = parsePositiveInt(env.EMAIL_DELIVERY_LEASE_DURATION_MS,
    DEFAULT_EMAIL_DELIVERY_LEASE_DURATION_MS, 'EMAIL_DELIVERY_LEASE_DURATION_MS',
    { min: 1_000, max: 600_000 });
  const emailDeliveryHeartbeatIntervalMs = parsePositiveInt(
    env.EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS, DEFAULT_EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS,
    'EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS', { min: 100, max: 300_000 });
  const emailDeliveryBatchSize = parsePositiveInt(env.EMAIL_DELIVERY_BATCH_SIZE,
    DEFAULT_EMAIL_DELIVERY_BATCH_SIZE, 'EMAIL_DELIVERY_BATCH_SIZE', { min: 1, max: 64 });
  if (emailDeliveryHeartbeatIntervalMs >= emailDeliveryLeaseDurationMs) {
    throw new Error('EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS must be smaller than EMAIL_DELIVERY_LEASE_DURATION_MS');
  }
  if (emailFlag === 'true' && !emailAccountName) {
    throw new Error('EMAIL_DM_ACCOUNT_NAME is required when KNOWN_FEATURE_EMAIL is enabled');
  }
  const worker: EmailDeliveryWorkerConfig = Object.freeze({
    maxAttempts: emailDeliveryMaxAttempts,
    baseBackoffMs: emailDeliveryBaseBackoffMs,
    maxBackoffMs: emailDeliveryMaxBackoffMs,
    pollIntervalMs: emailDeliveryPollIntervalMs,
    leaseDurationMs: emailDeliveryLeaseDurationMs,
    heartbeatIntervalMs: emailDeliveryHeartbeatIntervalMs,
    batchSize: emailDeliveryBatchSize,
  });
  return Object.freeze({
    enabled: emailFlag === 'true',
    endpoint: emailEndpoint,
    regionId: emailRegionId,
    accountName: emailAccountName,
    timeoutMs: emailTimeoutMs,
    tagPrefix: emailTagPrefix,
    maxTagChars: emailMaxTagChars,
    callback: Object.freeze({
      hmacSecret: emailCallbackHmacSecret,
      timestampReplayWindowMs: emailCallbackTimestampWindowMs,
    }),
    opsToken: emailOpsToken,
    opsRateLimit: Object.freeze({ maxRequests: emailOpsRateLimitMax,
      windowMs: emailOpsRateLimitWindowMs }),
    callbackRateLimit: Object.freeze({ maxRequests: emailCallbackRateLimitMax,
      windowMs: emailCallbackRateLimitWindowMs }),
    worker,
  });
}
