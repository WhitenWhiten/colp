import { isAbsolute, resolve, sep } from 'node:path';

import { parsePositiveInt, requireNonEmpty, requireSecret } from './config-parse-helpers.js';

export interface LedgerArchiveCredential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type LedgerArchiveStorageConfig = Readonly<{
  kind: 'filesystem';
  rootDirectory: string;
  uriBucket?: string;
}> | Readonly<{
  kind: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  readerCredential: LedgerArchiveCredential;
  writerCredential: LedgerArchiveCredential;
}>;

export interface LedgerArchiveRuntimeConfig {
  readonly enabled: boolean;
  readonly storage: LedgerArchiveStorageConfig | null;
  readonly kmsKeyId: string | null;
  readonly spoolDirectory: string;
  readonly pageSize: number;
  readonly byteCeiling: bigint;
  readonly leaseDurationMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
}

export interface SanitizedLedgerArchiveRuntimeConfig {
  readonly enabled: boolean;
  readonly storageKind: LedgerArchiveStorageConfig['kind'] | 'unconfigured';
  readonly bucket: string | null;
  readonly spoolDirectory: string;
  readonly pageSize: number;
  readonly byteCeiling: string;
  readonly leaseDurationMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  readonly concurrency: number;
  readonly pollIntervalMs: number;
}

export function loadLedgerArchiveRuntimeConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): LedgerArchiveRuntimeConfig {
  const enabled = parseBoolean(env.LEDGER_ARCHIVE_WORKER_ENABLED, false, 'LEDGER_ARCHIVE_WORKER_ENABLED');
  const spoolDirectory = env.LEDGER_ARCHIVE_SPOOL_DIR?.trim() || '/tmp/known-ledger-archive-spool';
  if (!isAbsolute(spoolDirectory)) throw new Error('LEDGER_ARCHIVE_SPOOL_DIR must be absolute');
  const common = {
    enabled,
    spoolDirectory,
    pageSize: parsePositiveInt(env.LEDGER_ARCHIVE_PAGE_SIZE, 1_000, 'LEDGER_ARCHIVE_PAGE_SIZE', { max: 10_000 }),
    byteCeiling: parsePositiveBigint(env.LEDGER_ARCHIVE_BYTE_CEILING, 20n * 1024n * 1024n * 1024n),
    leaseDurationMs: parsePositiveInt(env.LEDGER_ARCHIVE_LEASE_DURATION_MS, 300_000, 'LEDGER_ARCHIVE_LEASE_DURATION_MS', { min: 1_000, max: 3_600_000 }),
    retryDelayMs: parsePositiveInt(env.LEDGER_ARCHIVE_RETRY_DELAY_MS, 30_000, 'LEDGER_ARCHIVE_RETRY_DELAY_MS', { allowZero: true, max: 86_400_000 }),
    maxAttempts: parsePositiveInt(env.LEDGER_ARCHIVE_MAX_ATTEMPTS, 8, 'LEDGER_ARCHIVE_MAX_ATTEMPTS', { max: 100 }),
    concurrency: parsePositiveInt(env.LEDGER_ARCHIVE_CONCURRENCY, 1, 'LEDGER_ARCHIVE_CONCURRENCY', { max: 16 }),
    pollIntervalMs: parsePositiveInt(env.LEDGER_ARCHIVE_POLL_INTERVAL_MS, 5_000, 'LEDGER_ARCHIVE_POLL_INTERVAL_MS', { min: 10, max: 3_600_000 }),
  } as const;
  if (!enabled) return Object.freeze({ ...common, storage: null, kmsKeyId: null });

  const kmsKeyId = requireNonEmpty(env, 'LEDGER_ARCHIVE_KMS_KEY_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9:/_.-]{0,255}$/u.test(kmsKeyId)) {
    throw new Error('LEDGER_ARCHIVE_KMS_KEY_ID is invalid');
  }
  if (nodeEnv === 'production' && !env.LEDGER_ARCHIVE_SPOOL_DIR?.trim()) {
    throw new Error('LEDGER_ARCHIVE_SPOOL_DIR is required in production');
  }
  const kind = (env.LEDGER_ARCHIVE_STORE ?? (nodeEnv === 'production' ? 's3' : 'filesystem')).trim();
  if (kind === 'filesystem') {
    if (nodeEnv === 'production') throw new Error('LEDGER_ARCHIVE_STORE=filesystem is forbidden in production');
    const rootDirectory = requireNonEmpty(env, 'LEDGER_ARCHIVE_FILESYSTEM_ROOT');
    if (!isAbsolute(rootDirectory)) throw new Error('LEDGER_ARCHIVE_FILESYSTEM_ROOT must be absolute');
    assertSeparateDirectories(rootDirectory, spoolDirectory);
    const uriBucket = env.LEDGER_ARCHIVE_BUCKET?.trim();
    return Object.freeze({
      ...common,
      kmsKeyId,
      storage: Object.freeze({
        kind,
        rootDirectory,
        ...(uriBucket ? { uriBucket } : {}),
      }),
    });
  }
  if (kind !== 's3' && kind !== 'r2') throw new Error('LEDGER_ARCHIVE_STORE must be filesystem, s3, or r2');
  const endpoint = requireNonEmpty(env, 'LEDGER_ARCHIVE_S3_ENDPOINT');
  assertEndpoint(endpoint, nodeEnv);
  const readerCredential = credential(env, 'READER');
  const writerCredential = credential(env, 'WRITER');
  if (readerCredential.accessKeyId === writerCredential.accessKeyId
      || readerCredential.secretAccessKey === writerCredential.secretAccessKey) {
    throw new Error('Ledger archive reader and writer credentials must be distinct');
  }
  return Object.freeze({
    ...common,
    kmsKeyId,
    storage: Object.freeze({
      kind: 's3',
      endpoint,
      region: requireNonEmpty(env, 'LEDGER_ARCHIVE_S3_REGION', 'auto'),
      bucket: requireNonEmpty(env, 'LEDGER_ARCHIVE_BUCKET'),
      readerCredential,
      writerCredential,
    }),
  });
}

export function sanitizeLedgerArchiveRuntimeConfig(
  config: LedgerArchiveRuntimeConfig,
): SanitizedLedgerArchiveRuntimeConfig {
  return Object.freeze({
    enabled: config.enabled,
    storageKind: config.storage?.kind ?? 'unconfigured',
    bucket: config.storage?.kind === 's3'
      ? config.storage.bucket
      : config.storage?.uriBucket ?? null,
    spoolDirectory: config.spoolDirectory,
    pageSize: config.pageSize,
    byteCeiling: config.byteCeiling.toString(),
    leaseDurationMs: config.leaseDurationMs,
    retryDelayMs: config.retryDelayMs,
    maxAttempts: config.maxAttempts,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
  });
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim() === 'true') return true;
  if (raw.trim() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveBigint(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw.trim())) throw new Error('LEDGER_ARCHIVE_BYTE_CEILING must be a positive integer');
  const value = BigInt(raw.trim());
  if (value > 1_099_511_627_776n) throw new Error('LEDGER_ARCHIVE_BYTE_CEILING must be <= 1099511627776');
  return value;
}

function credential(env: NodeJS.ProcessEnv, role: 'READER' | 'WRITER'): LedgerArchiveCredential {
  return Object.freeze({
    accessKeyId: requireSecret(env, `LEDGER_ARCHIVE_S3_${role}_ACCESS_KEY_ID`),
    secretAccessKey: requireSecret(env, `LEDGER_ARCHIVE_S3_${role}_SECRET_ACCESS_KEY`),
  });
}

function assertEndpoint(raw: string, nodeEnv: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must be a credential-free HTTP(S) URL');
  }
  if (nodeEnv === 'production' && endpoint.protocol !== 'https:') {
    throw new Error('LEDGER_ARCHIVE_S3_ENDPOINT must use https in production');
  }
}

function assertSeparateDirectories(rootDirectory: string, spoolDirectory: string): void {
  const root = resolve(rootDirectory);
  const spool = resolve(spoolDirectory);
  if (root === spool || root.startsWith(`${spool}${sep}`) || spool.startsWith(`${root}${sep}`)) {
    throw new Error('LEDGER_ARCHIVE_SPOOL_DIR and LEDGER_ARCHIVE_FILESYSTEM_ROOT must be separate');
  }
}
