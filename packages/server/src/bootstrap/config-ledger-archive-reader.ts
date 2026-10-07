import { isAbsolute } from 'node:path';

import { parsePositiveInt, requireNonEmpty, requireSecret } from './config-parse-helpers.js';

export interface LedgerArchiveReaderCredential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type LedgerArchiveReaderStorageConfig = Readonly<{
  kind: 'filesystem';
  rootDirectory: string;
  uriBucket?: string;
  kmsKeyId: string;
}> | Readonly<{
  kind: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  readerCredential: LedgerArchiveReaderCredential;
}>;

export interface LedgerArchiveReaderRuntimeConfig {
  readonly enabled: boolean;
  readonly storage: LedgerArchiveReaderStorageConfig | null;
  readonly byteCeiling: bigint;
  readonly maxRowsPerSegment: number;
  readonly maxBytesPerSegment: bigint;
  readonly maxCachedBytes: bigint;
  readonly maxConcurrentLoads: number;
  readonly timeoutMs: number;
  readonly deprecations: readonly string[];
}

export interface SanitizedLedgerArchiveReaderRuntimeConfig {
  readonly enabled: boolean;
  readonly storageKind: LedgerArchiveReaderStorageConfig['kind'] | 'unconfigured';
  readonly bucket: string | null;
  readonly byteCeiling: string;
  readonly maxRowsPerSegment: number;
  readonly maxBytesPerSegment: string;
  readonly maxCachedBytes: string;
  readonly maxConcurrentLoads: number;
  readonly timeoutMs: number;
}

/** API/read-process archive config. Writer credentials are deliberately never parsed. */
export function loadLedgerArchiveReaderRuntimeConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): LedgerArchiveReaderRuntimeConfig {
  const enabled = parseBoolean(env.LEDGER_ARCHIVE_READ_ENABLED, 'LEDGER_ARCHIVE_READ_ENABLED');
  const common = Object.freeze({
    enabled,
    byteCeiling: parseBoundedBigint(
      env.LEDGER_ARCHIVE_READ_BYTE_CEILING, 256n * 1024n * 1024n,
      'LEDGER_ARCHIVE_READ_BYTE_CEILING', 2n * 1024n * 1024n * 1024n,
    ),
    maxRowsPerSegment: parsePositiveInt(
      env.LEDGER_ARCHIVE_READ_MAX_ROWS_PER_SEGMENT, 100_000,
      'LEDGER_ARCHIVE_READ_MAX_ROWS_PER_SEGMENT', { max: 1_000_000 },
    ),
    ...readCacheBudgets(env),
    timeoutMs: parsePositiveInt(
      env.LEDGER_ARCHIVE_READ_TIMEOUT_MS, 15_000,
      'LEDGER_ARCHIVE_READ_TIMEOUT_MS', { min: 100, max: 120_000 },
    ),
  });
  if (!enabled) return Object.freeze({ ...common, storage: null });

  const kind = (env.LEDGER_ARCHIVE_STORE ?? (nodeEnv === 'production' ? 's3' : 'filesystem')).trim();
  if (kind === 'filesystem') {
    if (nodeEnv === 'production') throw new Error('LEDGER_ARCHIVE_STORE=filesystem is forbidden in production');
    const rootDirectory = requireNonEmpty(env, 'LEDGER_ARCHIVE_FILESYSTEM_ROOT');
    if (!isAbsolute(rootDirectory)) throw new Error('LEDGER_ARCHIVE_FILESYSTEM_ROOT must be absolute');
    const kmsKeyId = requireNonEmpty(env, 'LEDGER_ARCHIVE_KMS_KEY_ID');
    assertKmsKeyId(kmsKeyId);
    const uriBucket = env.LEDGER_ARCHIVE_BUCKET?.trim();
    return Object.freeze({ ...common, storage: Object.freeze({
      kind, rootDirectory, kmsKeyId, ...(uriBucket ? { uriBucket } : {}),
    }) });
  }
  if (kind !== 's3' && kind !== 'r2') {
    throw new Error('LEDGER_ARCHIVE_STORE must be filesystem, s3, or r2');
  }
  const endpoint = requireNonEmpty(env, 'LEDGER_ARCHIVE_S3_ENDPOINT');
  assertEndpoint(endpoint, nodeEnv);
  return Object.freeze({ ...common, storage: Object.freeze({
    kind: 's3', endpoint,
    region: requireNonEmpty(env, 'LEDGER_ARCHIVE_S3_REGION', 'auto'),
    bucket: requireNonEmpty(env, 'LEDGER_ARCHIVE_BUCKET'),
    readerCredential: Object.freeze({
      accessKeyId: requireSecret(env, 'LEDGER_ARCHIVE_S3_READER_ACCESS_KEY_ID'),
      secretAccessKey: requireSecret(env, 'LEDGER_ARCHIVE_S3_READER_SECRET_ACCESS_KEY'),
    }),
  }) });
}

export function sanitizeLedgerArchiveReaderRuntimeConfig(
  config: LedgerArchiveReaderRuntimeConfig,
): SanitizedLedgerArchiveReaderRuntimeConfig {
  return Object.freeze({
    enabled: config.enabled,
    storageKind: config.storage?.kind ?? 'unconfigured',
    bucket: config.storage?.kind === 's3'
      ? config.storage.bucket : config.storage?.uriBucket ?? null,
    byteCeiling: config.byteCeiling.toString(),
    maxRowsPerSegment: config.maxRowsPerSegment,
    maxBytesPerSegment: config.maxBytesPerSegment.toString(),
    maxCachedBytes: config.maxCachedBytes.toString(),
    maxConcurrentLoads: config.maxConcurrentLoads,
    timeoutMs: config.timeoutMs,
  });
}

function readCacheBudgets(env: NodeJS.ProcessEnv): {
  readonly maxBytesPerSegment: bigint;
  readonly maxCachedBytes: bigint;
  readonly maxConcurrentLoads: number;
  readonly deprecations: readonly string[];
} {
  const deprecations: string[] = [];
  const aliasedMaterialized = env.LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES !== undefined
    && env.LEDGER_ARCHIVE_READ_MAX_BYTES_PER_SEGMENT === undefined;
  if (aliasedMaterialized) deprecations.push('LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES');
  const parsedPerSegment = parseBoundedBigint(
    env.LEDGER_ARCHIVE_READ_MAX_BYTES_PER_SEGMENT
      ?? env.LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES,
    16n * 1024n * 1024n,
    aliasedMaterialized
      ? 'LEDGER_ARCHIVE_READ_MAX_MATERIALIZED_BYTES'
      : 'LEDGER_ARCHIVE_READ_MAX_BYTES_PER_SEGMENT',
    aliasedMaterialized ? 2n * 1024n * 1024n * 1024n : 64n * 1024n * 1024n,
  );
  const maxBytesPerSegment = aliasedMaterialized
    ? minBigint(parsedPerSegment, 16n * 1024n * 1024n) : parsedPerSegment;
  let maxCachedBytes = parseBoundedBigint(
    env.LEDGER_ARCHIVE_READ_MAX_CACHED_BYTES, 64n * 1024n * 1024n,
    'LEDGER_ARCHIVE_READ_MAX_CACHED_BYTES', 128n * 1024n * 1024n,
  );
  let maxConcurrentLoads = parsePositiveInt(
    env.LEDGER_ARCHIVE_READ_MAX_CONCURRENT_LOADS, 2,
    'LEDGER_ARCHIVE_READ_MAX_CONCURRENT_LOADS', { max: 16 },
  );
  if (env.LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS !== undefined
      && env.LEDGER_ARCHIVE_READ_MAX_CACHED_BYTES === undefined) {
    deprecations.push('LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS');
    const legacy = parsePositiveInt(
      env.LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS, 2,
      'LEDGER_ARCHIVE_READ_MAX_CACHED_SEGMENTS', { max: 16 },
    );
    maxCachedBytes = minBigint(64n * 1024n * 1024n, BigInt(legacy) * maxBytesPerSegment);
    if (env.LEDGER_ARCHIVE_READ_MAX_CONCURRENT_LOADS === undefined) maxConcurrentLoads = Math.min(legacy, 2);
  }
  const heapBudget = maxCachedBytes + BigInt(maxConcurrentLoads) * maxBytesPerSegment;
  if (heapBudget > 256n * 1024n * 1024n) {
    throw new Error('LEDGER_ARCHIVE_READ cache plus in-flight loads must stay under 256MiB');
  }
  return Object.freeze({ maxBytesPerSegment, maxCachedBytes, maxConcurrentLoads, deprecations });
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function parseBoolean(raw: string | undefined, label: string): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  if (raw.trim() === 'true') return true;
  if (raw.trim() === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function parseBoundedBigint(raw: string | undefined, fallback: bigint, label: string, max: bigint): bigint {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw.trim())) throw new Error(`${label} must be a positive integer`);
  const value = BigInt(raw.trim());
  if (value > max) throw new Error(`${label} must be <= ${max}`);
  return value;
}

function assertKmsKeyId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:/_.-]{0,255}$/u.test(value)) {
    throw new Error('LEDGER_ARCHIVE_KMS_KEY_ID is invalid');
  }
}

function assertEndpoint(raw: string, nodeEnv: string): void {
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must be a credential-free HTTP(S) URL');
  }
  if (nodeEnv === 'production' && endpoint.protocol !== 'https:') {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must use https in production');
  }
}
