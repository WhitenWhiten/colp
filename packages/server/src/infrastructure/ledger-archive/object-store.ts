export const LEDGER_ARCHIVE_OBJECT_PREFIX = 'ledger-archives/v1/';

export type LedgerArchiveObjectFailureClass =
  | 'already_exists'
  | 'not_found'
  | 'precondition_failed'
  | 'aborted'
  | 'timeout'
  | 'overflow'
  | 'corrupt'
  | 'retryable'
  | 'configuration'
  | 'unknown';

export class LedgerArchiveObjectStoreError extends Error {
  constructor(
    readonly failureClass: LedgerArchiveObjectFailureClass,
    readonly stableCode: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveObjectStoreError';
  }
}

export interface LedgerArchiveObjectIdentity {
  readonly key: string;
  readonly uri: string;
  readonly byteLength: bigint;
  /** Canonical content identity, intentionally independent of provider multipart ETags. */
  readonly contentEtag: string;
  readonly providerEtag?: string;
  readonly sha256: string;
  readonly kmsKeyId: string;
}

export interface LedgerArchivePutInput {
  readonly key: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly byteLength: bigint;
  readonly sha256: string;
  readonly kmsKeyId: string;
  readonly signal?: AbortSignal;
}

export interface LedgerArchiveReadInput {
  readonly key: string;
  readonly byteCeiling: bigint;
  readonly signal?: AbortSignal;
}

export interface LedgerArchiveObjectRead {
  readonly identity: LedgerArchiveObjectIdentity;
  readonly body: AsyncIterable<Uint8Array>;
  /** Release the response even when validation rejects it before iteration. Idempotent. */
  close(): void | Promise<void>;
}

export interface LedgerArchiveObjectReader {
  readonly uriForKey: (key: string) => string;
  readonly head: (key: string, signal?: AbortSignal) => Promise<LedgerArchiveObjectIdentity>;
  readonly read: (input: LedgerArchiveReadInput) => Promise<LedgerArchiveObjectRead>;
}

/** Deliberately has no overwrite, list, or delete capability. */
export interface LedgerArchiveObjectStore extends LedgerArchiveObjectReader {
  readonly putCreateOnly: (input: LedgerArchivePutInput) => Promise<LedgerArchiveObjectIdentity>;
}

export function assertLedgerArchiveObjectKey(key: string): void {
  if (!key.startsWith(LEDGER_ARCHIVE_OBJECT_PREFIX)
      || key.length > 768
      || key.includes('..')
      || key.includes('\\')
      || !/^[A-Za-z0-9/_.,=-]+$/u.test(key)
      || !/-[0-9a-f]{64}\.jsonl$/u.test(key)) {
    throw new LedgerArchiveObjectStoreError(
      'configuration', 'archive_key_invalid', 'Ledger archive object key is outside its namespace.',
    );
  }
}

export function digestFromLedgerArchiveObjectKey(key: string): string {
  assertLedgerArchiveObjectKey(key);
  const match = /-([0-9a-f]{64})\.jsonl$/u.exec(key);
  if (!match?.[1]) throw new LedgerArchiveObjectStoreError(
    'configuration', 'archive_key_digest_missing', 'Ledger archive object key has no content digest.',
  );
  return `sha256:${match[1]}`;
}

export function normalizeSha256(value: string): string {
  const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new LedgerArchiveObjectStoreError(
      'configuration', 'archive_digest_invalid', 'Ledger archive SHA-256 is invalid.',
    );
  }
  return normalized;
}

export function contentEtag(sha256: string): string {
  return normalizeSha256(sha256);
}
