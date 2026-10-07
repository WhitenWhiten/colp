import {
  parseCacheBooleanEnv,
  parsePositiveInt,
} from './config-parse-helpers.js';
import { resolveCacheRedisUrl } from './config-redis-roles.js';
import type {
  CacheConfig,
  CacheMode,
  CacheTtlConfig,
  DatabasePoolConfig,
  PublicationInsightRetentionConfig,
  PublisherReceiptRetentionConfig,
  WorkerConcurrencyConfig,
} from './config-types.js';

const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 2_000;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_DB_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_DB_IDLE_TX_TIMEOUT_MS = 15_000;

const DEFAULT_WORKER_BATCH_SIZE = 1;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 250;
const DEFAULT_WORKER_LEASE_DURATION_MS = 30_000;
const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_WORKER_CONCURRENCY = 1;
const MAX_DB_POOL = 200;
const MAX_WORKER_CONCURRENCY = 64;
const MAX_WORKER_BATCH = 64;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_LEASE_DURATION_MS = 600_000;
const MAX_HANDLER_TIMEOUT_MS = 600_000;
const MAX_DB_TIMEOUT_MS = 600_000;
const DEFAULT_PUBLISHER_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_PUBLISHER_CLEANUP_BATCH_SIZE = 100;
const DEFAULT_PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE = 5_000;
const DEFAULT_CACHE_MODE: CacheMode = 'off';
const DEFAULT_CACHE_REQUIRED = false;
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 75;
const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_REDIS_MAX_RETRIES_PER_REQUEST = 1;
const DEFAULT_REDIS_KEY_PREFIX = 'known';
const DEFAULT_CACHE_MAX_ENTRY_BYTES = 524_288;
const DEFAULT_CACHE_LOCK_TTL_MS = 1_500;
const DEFAULT_CACHE_METADATA_SOFT_TTL_MS = 10_000;
const DEFAULT_CACHE_METADATA_HARD_TTL_MS = 30_000;
const DEFAULT_CACHE_SNAPSHOT_SOFT_TTL_MS = 10_000;
const DEFAULT_CACHE_SNAPSHOT_HARD_TTL_MS = 30_000;
const DEFAULT_CACHE_DIRECTORY_SOFT_TTL_MS = 5_000;
const DEFAULT_CACHE_DIRECTORY_HARD_TTL_MS = 15_000;
const DEFAULT_CACHE_PUBLICATION_METADATA_ENABLED = false;
const DEFAULT_CACHE_PUBLICATION_DIRECTORY_ENABLED = false;
const DEFAULT_CACHE_PUBLICATION_SNAPSHOT_ENABLED = false;
const DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED = false;
const DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS = 60_000;
const DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS = 300_000;
const DEFAULT_CACHE_REPORT_METADATA_SOFT_TTL_MS = 10_000;
const DEFAULT_CACHE_REPORT_METADATA_HARD_TTL_MS = 30_000;
const DEFAULT_CACHE_REPORT_ISSUES_SOFT_TTL_MS = 10_000;
const DEFAULT_CACHE_REPORT_ISSUES_HARD_TTL_MS = 30_000;
const DEFAULT_CACHE_REPORT_DIRECTORY_SOFT_TTL_MS = 5_000;
const DEFAULT_CACHE_REPORT_DIRECTORY_HARD_TTL_MS = 15_000;
const DEFAULT_CACHE_REPORT_METADATA_ENABLED = false;
const DEFAULT_CACHE_REPORT_ISSUES_ENABLED = false;
const DEFAULT_CACHE_REPORT_DIRECTORY_ENABLED = false;

// T01 safety ceilings (fail closed beyond these; see plan §5.1/§6.4):
// - command timeout 5s: a Redis command must never outlive a request budget.
// - connect timeout 30s: startup cannot block on Redis longer than bounded.
// - max retries 10: offline queue is disabled (T03), retries stay bounded.
// - entry 512 KiB: first-phase single-value ceiling; oversize keeps paging.
// - lock TTL 60s: short coordination lock, never a durable lease.
// - hard TTL: domain-specific public revocation windows from plan §3.3.
const MAX_REDIS_COMMAND_TIMEOUT_MS = 5_000;
const MAX_REDIS_CONNECT_TIMEOUT_MS = 30_000;
const MAX_REDIS_MAX_RETRIES_PER_REQUEST = 10;
const MAX_CACHE_ENTRY_BYTES = 524_288;
const MAX_CACHE_LOCK_TTL_MS = 60_000;
const REDIS_KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;


export function loadDatabasePoolConfig(env: NodeJS.ProcessEnv): DatabasePoolConfig {
  return Object.freeze({
    maxConnections: parsePositiveInt(
      env.DATABASE_POOL_MAX,
      DEFAULT_DB_POOL_MAX,
      'DATABASE_POOL_MAX',
      { max: MAX_DB_POOL },
    ),
    connectionTimeoutMs: parsePositiveInt(
      env.DATABASE_CONNECTION_TIMEOUT_MS,
      DEFAULT_DB_CONNECTION_TIMEOUT_MS,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      { max: MAX_DB_TIMEOUT_MS },
    ),
    idleTimeoutMs: parsePositiveInt(
      env.DATABASE_IDLE_TIMEOUT_MS,
      DEFAULT_DB_IDLE_TIMEOUT_MS,
      'DATABASE_IDLE_TIMEOUT_MS',
      { max: MAX_DB_TIMEOUT_MS },
    ),
    statementTimeoutMs: parsePositiveInt(
      env.DATABASE_STATEMENT_TIMEOUT_MS,
      DEFAULT_DB_STATEMENT_TIMEOUT_MS,
      'DATABASE_STATEMENT_TIMEOUT_MS',
      { max: MAX_DB_TIMEOUT_MS },
    ),
    lockTimeoutMs: parsePositiveInt(
      env.DATABASE_LOCK_TIMEOUT_MS,
      DEFAULT_DB_LOCK_TIMEOUT_MS,
      'DATABASE_LOCK_TIMEOUT_MS',
      { max: MAX_DB_TIMEOUT_MS },
    ),
    idleTransactionTimeoutMs: parsePositiveInt(
      env.DATABASE_IDLE_TX_TIMEOUT_MS,
      DEFAULT_DB_IDLE_TX_TIMEOUT_MS,
      'DATABASE_IDLE_TX_TIMEOUT_MS',
      { max: MAX_DB_TIMEOUT_MS },
    ),
  });
}

/**
 * PGC-01 / T-06 connection budget (2026-08-27 backend performance audit).
 *
 * The worker process multiplexes every enabled claim loop (outbox plus
 * link-health / readable-replica / export-job) over ONE pg pool, and each API
 * process additionally parks one pooled connection on a permanent LISTEN.
 * Without a budget the loops silently starve each other on the 2s
 * connectionTimeout, and adding API replicas linearly exhausts the server's
 * max_connections. Both checks fail fast at startup:
 *
 * 1. sum(enabled worker loop concurrencies) <= DATABASE_POOL_MAX - reserve
 *    (reserve = 2: the MCP LISTEN slot + one maintenance/cancel headroom).
 * 2. when DATABASE_SERVER_MAX_CONNECTIONS is set (deployments pass the value
 *    used for postgres -c max_connections):
 *    apiReplicas x pool + worker pool + fixed overhead <= server max.
 *    Overhead 6 = superuser reserve 3 + autovacuum/cancel/migrator headroom.
 */
export interface WorkerLoopBudgetEntry {
  readonly name: string;
  readonly concurrency: number;
}

export const DATABASE_BUDGET_POOL_RESERVE = 2;
export const DATABASE_BUDGET_SERVER_OVERHEAD = 6;

export function assertDatabaseConnectionBudget(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly database: DatabasePoolConfig;
  readonly workerLoops: readonly WorkerLoopBudgetEntry[];
  readonly apiReplicas: number;
}): void {
  const loops = input.workerLoops.filter((loop) => loop.concurrency > 0);
  const loopSum = loops.reduce((sum, loop) => sum + loop.concurrency, 0);
  const poolBudget = input.database.maxConnections - DATABASE_BUDGET_POOL_RESERVE;
  if (loopSum > poolBudget) {
    const detail = loops.map((loop) => `${loop.name}=${loop.concurrency}`).join(' + ');
    throw new Error(
      `Worker loop concurrency total (${detail} = ${loopSum}) must be <= `
      + `DATABASE_POOL_MAX - ${DATABASE_BUDGET_POOL_RESERVE} (${poolBudget}); `
      + 'raise DATABASE_POOL_MAX or lower the loop concurrencies',
    );
  }
  const serverMaxRaw = input.env.DATABASE_SERVER_MAX_CONNECTIONS;
  if (serverMaxRaw === undefined || serverMaxRaw.trim() === '') return;
  const serverMax = parsePositiveInt(
    serverMaxRaw,
    0,
    'DATABASE_SERVER_MAX_CONNECTIONS',
    { max: 100_000 },
  );
  const demand = (input.apiReplicas * input.database.maxConnections)
    + input.database.maxConnections
    + DATABASE_BUDGET_SERVER_OVERHEAD;
  if (demand > serverMax) {
    throw new Error(
      `Declared PostgreSQL connection demand (${input.apiReplicas} API replicas x `
      + `DATABASE_POOL_MAX ${input.database.maxConnections} + worker pool `
      + `${input.database.maxConnections} + overhead ${DATABASE_BUDGET_SERVER_OVERHEAD} `
      + `= ${demand}) exceeds DATABASE_SERVER_MAX_CONNECTIONS (${serverMax}); `
      + 'raise max_connections, lower DATABASE_POOL_MAX or reduce AUTH_API_REPLICAS',
    );
  }
}

export function loadWorkerConcurrencyConfig(
  env: NodeJS.ProcessEnv,
  database: DatabasePoolConfig,
): WorkerConcurrencyConfig {
  const concurrency = parsePositiveInt(
    env.WORKER_CONCURRENCY,
    DEFAULT_WORKER_CONCURRENCY,
    'WORKER_CONCURRENCY',
    { max: MAX_WORKER_CONCURRENCY },
  );
  const batchSize = parsePositiveInt(
    env.WORKER_BATCH_SIZE,
    DEFAULT_WORKER_BATCH_SIZE,
    'WORKER_BATCH_SIZE',
    { max: MAX_WORKER_BATCH },
  );
  const pollIntervalMs = parsePositiveInt(
    env.WORKER_POLL_INTERVAL_MS,
    DEFAULT_WORKER_POLL_INTERVAL_MS,
    'WORKER_POLL_INTERVAL_MS',
    { max: MAX_POLL_INTERVAL_MS },
  );
  const leaseDurationMs = parsePositiveInt(
    env.WORKER_LEASE_DURATION_MS,
    DEFAULT_WORKER_LEASE_DURATION_MS,
    'WORKER_LEASE_DURATION_MS',
    { max: MAX_LEASE_DURATION_MS },
  );
  const heartbeatIntervalMs = parsePositiveInt(
    env.WORKER_HEARTBEAT_INTERVAL_MS,
    DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    'WORKER_HEARTBEAT_INTERVAL_MS',
    { max: MAX_LEASE_DURATION_MS },
  );
  const handlerTimeoutMs = parsePositiveInt(
    env.WORKER_HANDLER_TIMEOUT_MS,
    leaseDurationMs,
    'WORKER_HANDLER_TIMEOUT_MS',
    { max: MAX_HANDLER_TIMEOUT_MS },
  );

  if (concurrency > database.maxConnections) {
    throw new Error(
      `WORKER_CONCURRENCY (${concurrency}) must be <= DATABASE_POOL_MAX (${database.maxConnections}); `
      + 'worker concurrency must not exceed database pool capacity',
    );
  }
  if (batchSize > concurrency) {
    throw new Error(
      `WORKER_BATCH_SIZE (${batchSize}) must be <= WORKER_CONCURRENCY (${concurrency})`,
    );
  }
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error(
      `WORKER_HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}) must be < `
      + `WORKER_LEASE_DURATION_MS (${leaseDurationMs})`,
    );
  }
  if (handlerTimeoutMs > leaseDurationMs) {
    throw new Error(
      `WORKER_HANDLER_TIMEOUT_MS (${handlerTimeoutMs}) must be <= `
      + `WORKER_LEASE_DURATION_MS (${leaseDurationMs}) so leases outlive handler deadlines`,
    );
  }

  return Object.freeze({
    batchSize,
    pollIntervalMs,
    leaseDurationMs,
    heartbeatIntervalMs,
    handlerTimeoutMs,
    concurrency,
  });
}

export function loadPublisherReceiptRetentionConfig(
  env: NodeJS.ProcessEnv,
): PublisherReceiptRetentionConfig {
  return Object.freeze({
    cleanupIntervalMs: parsePositiveInt(
      env.PUBLISHER_RECEIPT_CLEANUP_INTERVAL_MS,
      DEFAULT_PUBLISHER_CLEANUP_INTERVAL_MS,
      'PUBLISHER_RECEIPT_CLEANUP_INTERVAL_MS',
    ),
    cleanupBatchSize: parsePositiveInt(
      env.PUBLISHER_RECEIPT_CLEANUP_BATCH_SIZE,
      DEFAULT_PUBLISHER_CLEANUP_BATCH_SIZE,
      'PUBLISHER_RECEIPT_CLEANUP_BATCH_SIZE',
      { max: 10_000 },
    ),
  });
}

export function loadPublicationInsightRetentionConfig(
  env: NodeJS.ProcessEnv,
): PublicationInsightRetentionConfig {
  return Object.freeze({
    cleanupIntervalMs: parsePositiveInt(
      env.PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS,
      DEFAULT_PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS,
      'PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS',
    ),
    cleanupBatchSize: parsePositiveInt(
      env.PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE,
      DEFAULT_PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE,
      'PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE',
      { max: 10_000 },
    ),
  });
}


export function loadCacheTtlPair(
  env: NodeJS.ProcessEnv,
  softKey: string,
  hardKey: string,
  softDefault: number,
  hardDefault: number,
  maxHardTtlMs: number,
): CacheTtlConfig {
  const softTtlMs = parsePositiveInt(env[softKey], softDefault, softKey, { max: maxHardTtlMs });
  const hardTtlMs = parsePositiveInt(env[hardKey], hardDefault, hardKey, { max: maxHardTtlMs });
  if (softTtlMs >= hardTtlMs) {
    throw new Error(
      `${softKey} must be < ${hardKey} (soft TTL must be strictly smaller than hard TTL)`,
    );
  }
  return Object.freeze({ softTtlMs, hardTtlMs });
}


export function loadCacheConfig(env: NodeJS.ProcessEnv): CacheConfig {
  const modeRaw = (env.KNOWN_CACHE_MODE ?? DEFAULT_CACHE_MODE).trim().toLowerCase();
  if (modeRaw !== 'off' && modeRaw !== 'shadow' && modeRaw !== 'serve') {
    throw new Error('KNOWN_CACHE_MODE must be one of off, shadow or serve');
  }
  const mode = modeRaw as CacheMode;

  const required = parseCacheBooleanEnv(env, 'KNOWN_CACHE_REQUIRED', DEFAULT_CACHE_REQUIRED);

  const resolvedCache = resolveCacheRedisUrl(env);
  let url = resolvedCache.url;
  if (url === null && mode !== 'off') {
    // shadow/serve cannot run against a missing connection string; this also
    // covers production, which must never fall back to a development default.
    throw new Error(
      'CACHE_REDIS_URL or REDIS_URL is required when KNOWN_CACHE_MODE is shadow or serve',
    );
  }

  const commandTimeoutMs = parsePositiveInt(
    env.REDIS_COMMAND_TIMEOUT_MS,
    DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    'REDIS_COMMAND_TIMEOUT_MS',
    { max: MAX_REDIS_COMMAND_TIMEOUT_MS },
  );
  const connectTimeoutMs = parsePositiveInt(
    env.REDIS_CONNECT_TIMEOUT_MS,
    DEFAULT_REDIS_CONNECT_TIMEOUT_MS,
    'REDIS_CONNECT_TIMEOUT_MS',
    { max: MAX_REDIS_CONNECT_TIMEOUT_MS },
  );
  const maxRetriesPerRequest = parsePositiveInt(
    env.REDIS_MAX_RETRIES_PER_REQUEST,
    DEFAULT_REDIS_MAX_RETRIES_PER_REQUEST,
    'REDIS_MAX_RETRIES_PER_REQUEST',
    { allowZero: true, max: MAX_REDIS_MAX_RETRIES_PER_REQUEST },
  );
  const keyPrefix = (env.REDIS_KEY_PREFIX ?? DEFAULT_REDIS_KEY_PREFIX).trim();
  if (!REDIS_KEY_PREFIX_PATTERN.test(keyPrefix)) {
    throw new Error(
      'REDIS_KEY_PREFIX must be 1-64 characters starting with an alphanumeric and using only [A-Za-z0-9_.:-]',
    );
  }
  const maxEntryBytes = parsePositiveInt(
    env.CACHE_MAX_ENTRY_BYTES,
    DEFAULT_CACHE_MAX_ENTRY_BYTES,
    'CACHE_MAX_ENTRY_BYTES',
    { max: MAX_CACHE_ENTRY_BYTES },
  );
  const lockTtlMs = parsePositiveInt(
    env.CACHE_LOCK_TTL_MS,
    DEFAULT_CACHE_LOCK_TTL_MS,
    'CACHE_LOCK_TTL_MS',
    { max: MAX_CACHE_LOCK_TTL_MS },
  );

  const metadata = loadCacheTtlPair(
    env, 'CACHE_METADATA_SOFT_TTL_MS', 'CACHE_METADATA_HARD_TTL_MS',
    DEFAULT_CACHE_METADATA_SOFT_TTL_MS, DEFAULT_CACHE_METADATA_HARD_TTL_MS,
    DEFAULT_CACHE_METADATA_HARD_TTL_MS,
  );
  const snapshot = loadCacheTtlPair(
    env, 'CACHE_SNAPSHOT_SOFT_TTL_MS', 'CACHE_SNAPSHOT_HARD_TTL_MS',
    DEFAULT_CACHE_SNAPSHOT_SOFT_TTL_MS, DEFAULT_CACHE_SNAPSHOT_HARD_TTL_MS,
    DEFAULT_CACHE_SNAPSHOT_HARD_TTL_MS,
  );
  const directory = loadCacheTtlPair(
    env, 'CACHE_DIRECTORY_SOFT_TTL_MS', 'CACHE_DIRECTORY_HARD_TTL_MS',
    DEFAULT_CACHE_DIRECTORY_SOFT_TTL_MS, DEFAULT_CACHE_DIRECTORY_HARD_TTL_MS,
    DEFAULT_CACHE_DIRECTORY_HARD_TTL_MS,
  );

  const metadataEnabled = parseCacheBooleanEnv(
    env, 'CACHE_PUBLICATION_METADATA_ENABLED', DEFAULT_CACHE_PUBLICATION_METADATA_ENABLED,
  );
  const directoryEnabled = parseCacheBooleanEnv(
    env, 'CACHE_PUBLICATION_DIRECTORY_ENABLED', DEFAULT_CACHE_PUBLICATION_DIRECTORY_ENABLED,
  );
  const snapshotEnabled = parseCacheBooleanEnv(
    env, 'CACHE_PUBLICATION_SNAPSHOT_ENABLED', DEFAULT_CACHE_PUBLICATION_SNAPSHOT_ENABLED,
  );
  const bookmarkCount = loadCacheTtlPair(
    env, 'CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS', 'CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS',
    DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_SOFT_TTL_MS, DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS,
    DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_HARD_TTL_MS,
  );
  const bookmarkCountEnabled = parseCacheBooleanEnv(
    env, 'CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED', DEFAULT_CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED,
  );
  const reportMetadata = loadCacheTtlPair(env, 'CACHE_REPORT_METADATA_SOFT_TTL_MS', 'CACHE_REPORT_METADATA_HARD_TTL_MS', DEFAULT_CACHE_REPORT_METADATA_SOFT_TTL_MS, DEFAULT_CACHE_REPORT_METADATA_HARD_TTL_MS, DEFAULT_CACHE_REPORT_METADATA_HARD_TTL_MS);
  const reportIssues = loadCacheTtlPair(env, 'CACHE_REPORT_ISSUES_SOFT_TTL_MS', 'CACHE_REPORT_ISSUES_HARD_TTL_MS', DEFAULT_CACHE_REPORT_ISSUES_SOFT_TTL_MS, DEFAULT_CACHE_REPORT_ISSUES_HARD_TTL_MS, DEFAULT_CACHE_REPORT_ISSUES_HARD_TTL_MS);
  const reportDirectory = loadCacheTtlPair(env, 'CACHE_REPORT_DIRECTORY_SOFT_TTL_MS', 'CACHE_REPORT_DIRECTORY_HARD_TTL_MS', DEFAULT_CACHE_REPORT_DIRECTORY_SOFT_TTL_MS, DEFAULT_CACHE_REPORT_DIRECTORY_HARD_TTL_MS, DEFAULT_CACHE_REPORT_DIRECTORY_HARD_TTL_MS);
  const reportMetadataEnabled = parseCacheBooleanEnv(env, 'CACHE_REPORT_METADATA_ENABLED', DEFAULT_CACHE_REPORT_METADATA_ENABLED);
  const reportIssuesEnabled = parseCacheBooleanEnv(env, 'CACHE_REPORT_ISSUES_ENABLED', DEFAULT_CACHE_REPORT_ISSUES_ENABLED);
  const reportDirectoryEnabled = parseCacheBooleanEnv(env, 'CACHE_REPORT_DIRECTORY_ENABLED', DEFAULT_CACHE_REPORT_DIRECTORY_ENABLED);

  return Object.freeze({
    redis: Object.freeze({
      mode,
      required,
      url,
      commandTimeoutMs,
      connectTimeoutMs,
      maxRetriesPerRequest,
      keyPrefix,
    }),
    limits: Object.freeze({ maxEntryBytes, lockTtlMs }),
    publication: Object.freeze({
      metadata,
      snapshot,
      directory,
      metadataEnabled,
      directoryEnabled,
      snapshotEnabled,
    }),
    collection: Object.freeze({
      bookmarkCount,
      bookmarkCountEnabled,
    }),
    reports: Object.freeze({ metadata: reportMetadata, issues: reportIssues, directory: reportDirectory, metadataEnabled: reportMetadataEnabled, issuesEnabled: reportIssuesEnabled, directoryEnabled: reportDirectoryEnabled }),
  });
}
