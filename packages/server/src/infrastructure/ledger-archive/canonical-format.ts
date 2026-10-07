import { createHash } from 'node:crypto';

export const LEDGER_ARCHIVE_SCHEMA_VERSION = 1;
export const LEDGER_ARCHIVE_MEDIA_TYPE = 'application/x-known-ledger-archive+jsonl;version=1';

export interface LedgerArchiveHeaderInput {
  readonly ledgerFamily: string;
  readonly sourceRelation: string;
  readonly sourceScope: string;
  readonly lowerInclusive: bigint;
  readonly upperExclusive: bigint;
}

export interface LedgerArchiveEncodedSummary {
  readonly rowCount: bigint;
  readonly byteLength: bigint;
  readonly contentDigest: string;
  readonly rowsDigest: string;
  readonly firstKey: bigint | null;
  readonly lastKey: bigint | null;
}

export interface LedgerArchiveVerifyExpectation extends LedgerArchiveHeaderInput {
  readonly rowCount?: bigint;
  readonly contentDigest?: string;
}

export class LedgerArchiveFormatError extends Error {
  constructor(readonly stableCode: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LedgerArchiveFormatError';
  }
}

export async function encodeLedgerArchiveV1(
  header: LedgerArchiveHeaderInput,
  rows: AsyncIterable<Readonly<{ key: bigint; value: unknown }>>,
  write: (chunk: Uint8Array) => Promise<void>,
  options: Readonly<{ byteCeiling: bigint; signal?: AbortSignal }>,
): Promise<LedgerArchiveEncodedSummary> {
  validateHeader(header);
  const prefixHash = createHash('sha256');
  const fullHash = createHash('sha256');
  let byteLength = 0n;
  let rowCount = 0n;
  let firstKey: bigint | null = null;
  let lastKey: bigint | null = null;

  const emit = async (value: unknown, prefix: boolean): Promise<void> => {
    if (options.signal?.aborted) throw formatError('archive_aborted', 'Archive encoding was aborted.');
    const chunk = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    byteLength += BigInt(chunk.byteLength);
    if (byteLength > options.byteCeiling) throw formatError('archive_byte_ceiling', 'Archive exceeded its byte ceiling.');
    if (prefix) prefixHash.update(chunk);
    fullHash.update(chunk);
    await write(chunk);
  };

  await emit({
    type: 'known-ledger-archive', version: 1,
    ledgerFamily: header.ledgerFamily, sourceRelation: header.sourceRelation,
    sourceScope: header.sourceScope, sourceKeyKind: 'bigint',
    sourceKeyComparator: 'signed-bigint-ascending-v1',
    lowerInclusive: header.lowerInclusive.toString(), upperExclusive: header.upperExclusive.toString(),
  }, true);

  for await (const row of rows) {
    if (row.key < header.lowerInclusive || row.key >= header.upperExclusive
        || (lastKey !== null && row.key <= lastKey)) {
      throw formatError('archive_row_key_invalid', 'Archive row key is outside bounds or not strictly ascending.');
    }
    firstKey ??= row.key;
    lastKey = row.key;
    rowCount += 1n;
    await emit({ type: 'row', key: row.key.toString(), value: row.value }, true);
  }
  const rowsDigest = `sha256:${prefixHash.digest('hex')}`;
  await emit({
    type: 'footer', rowCount: rowCount.toString(),
    firstKey: firstKey?.toString() ?? null, lastKey: lastKey?.toString() ?? null,
    lowerInclusive: header.lowerInclusive.toString(), upperExclusive: header.upperExclusive.toString(),
    rowsDigest,
  }, false);
  return Object.freeze({
    rowCount, byteLength, rowsDigest, firstKey, lastKey,
    contentDigest: `sha256:${fullHash.digest('hex')}`,
  });
}

export async function verifyLedgerArchiveV1(
  body: AsyncIterable<Uint8Array>,
  expectation: LedgerArchiveVerifyExpectation,
  options: Readonly<{
    byteCeiling: bigint;
    maxLineBytes?: number;
    signal?: AbortSignal;
    onRow?: (row: Readonly<{ key: bigint; value: unknown }>) => void | Promise<void>;
  }>,
): Promise<LedgerArchiveEncodedSummary> {
  validateHeader(expectation);
  const prefixHash = createHash('sha256');
  const fullHash = createHash('sha256');
  let bytes = 0n;
  let rowCount = 0n;
  let firstKey: bigint | null = null;
  let lastKey: bigint | null = null;
  let lineNumber = 0;
  let footerDigest: string | undefined;
  let footerSeen = false;

  for await (const rawLine of splitJsonLines(body, options)) {
    lineNumber += 1;
    bytes += BigInt(rawLine.byteLength);
    if (bytes > options.byteCeiling) throw formatError('archive_byte_ceiling', 'Archive exceeded its byte ceiling.');
    fullHash.update(rawLine);
    let lineText: string;
    try {
      lineText = new TextDecoder('utf-8', { fatal: true }).decode(rawLine.subarray(0, rawLine.byteLength - 1));
    } catch (error) {
      throw formatError('archive_utf8_invalid', 'Archive contains invalid UTF-8.', error);
    }
    let value: unknown;
    try {
      value = JSON.parse(lineText);
    } catch (error) {
      throw formatError('archive_json_invalid', 'Archive contains invalid JSON.', error);
    }
    if (canonicalJson(value) !== lineText) throw formatError('archive_not_canonical', 'Archive JSON is not canonical.');
    const record = requireRecord(value);
    if (lineNumber === 1) {
      verifyHeaderRecord(record, expectation);
      prefixHash.update(rawLine);
      continue;
    }
    if (record.type === 'row' && !footerSeen) {
      assertExactKeys(record, ['key', 'type', 'value'], 'archive_row_schema_invalid');
      const key = parseCanonicalBigint(record.key, 'archive_row_key_invalid');
      if (key < expectation.lowerInclusive || key >= expectation.upperExclusive
          || (lastKey !== null && key <= lastKey)) {
        throw formatError('archive_row_key_invalid', 'Archive row keys are invalid.');
      }
      prefixHash.update(rawLine);
      firstKey ??= key;
      lastKey = key;
      rowCount += 1n;
      await options.onRow?.(Object.freeze({ key, value: record.value }));
      continue;
    }
    if (record.type === 'footer' && !footerSeen) {
      assertExactKeys(record, [
        'firstKey', 'lastKey', 'lowerInclusive', 'rowCount', 'rowsDigest', 'type', 'upperExclusive',
      ], 'archive_footer_invalid');
      footerSeen = true;
      footerDigest = String(record.rowsDigest);
      if (parseCanonicalBigint(record.rowCount, 'archive_footer_invalid') !== rowCount
          || record.firstKey !== (firstKey?.toString() ?? null)
          || record.lastKey !== (lastKey?.toString() ?? null)
          || record.lowerInclusive !== expectation.lowerInclusive.toString()
          || record.upperExclusive !== expectation.upperExclusive.toString()) {
        throw formatError('archive_footer_invalid', 'Archive footer does not bind its rows and bounds.');
      }
      continue;
    }
    throw formatError('archive_record_order_invalid', 'Archive record ordering is invalid.');
  }
  if (lineNumber === 0 || !footerSeen) throw formatError('archive_truncated', 'Archive header or footer is missing.');
  const rowsDigest = `sha256:${prefixHash.digest('hex')}`;
  const contentDigest = `sha256:${fullHash.digest('hex')}`;
  if (footerDigest !== rowsDigest) throw formatError('archive_rows_digest_mismatch', 'Archive row digest does not match.');
  if (expectation.rowCount !== undefined && expectation.rowCount !== rowCount) {
    throw formatError('archive_row_count_mismatch', 'Archive row count does not match the manifest.');
  }
  if (expectation.contentDigest !== undefined && expectation.contentDigest !== contentDigest) {
    throw formatError('archive_content_digest_mismatch', 'Archive content digest does not match the manifest.');
  }
  return Object.freeze({ rowCount, byteLength: bytes, contentDigest, rowsDigest, firstKey, lastKey });
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return `{"$knownType":"bigint","value":${JSON.stringify(value.toString())}}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw formatError('archive_value_unsupported', 'Only safe integer numbers are supported.');
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw formatError('archive_value_unsupported', 'Invalid dates are unsupported.');
    return `{"$knownType":"timestamp","value":${JSON.stringify(value.toISOString())}}`;
  }
  if (typeof value !== 'object' || value === undefined) throw formatError('archive_value_unsupported', 'Archive value type is unsupported.');
  if (ancestors.has(value)) throw formatError('archive_value_cycle', 'Archive value contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => serializeCanonical(item, ancestors)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw formatError('archive_value_unsupported', 'Archive objects must be plain.');
    return `{${Object.keys(value as object).sort().map((key) => {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw formatError('archive_value_unsupported', 'Undefined archive fields are unsupported.');
      return `${JSON.stringify(key)}:${serializeCanonical(child, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function* splitJsonLines(
  body: AsyncIterable<Uint8Array>,
  options: Readonly<{ maxLineBytes?: number; signal?: AbortSignal }>,
): AsyncGenerator<Uint8Array> {
  const maximum = options.maxLineBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > 16 * 1024 * 1024) {
    throw formatError('archive_line_ceiling_invalid', 'Archive line ceiling is invalid.');
  }
  const lineBuffer = Buffer.allocUnsafe(maximum);
  let bufferedBytes = 0;
  for await (const chunk of body) {
    if (options.signal?.aborted) throw formatError('archive_aborted', 'Archive verification was aborted.');
    const bytes = Buffer.from(chunk);
    let start = 0;
    let newline: number;
    while ((newline = bytes.indexOf(0x0a, start)) >= 0) {
      const part = bytes.subarray(start, newline + 1);
      const lineBytes = bufferedBytes + part.byteLength;
      if (lineBytes > maximum) throw formatError('archive_line_ceiling', 'Archive line exceeded its byte ceiling.');
      const raw = Buffer.allocUnsafe(lineBytes);
      if (bufferedBytes > 0) lineBuffer.copy(raw, 0, 0, bufferedBytes);
      part.copy(raw, bufferedBytes);
      yield raw;
      bufferedBytes = 0;
      start = newline + 1;
    }
    if (start < bytes.byteLength) {
      const trailing = Buffer.from(bytes.subarray(start));
      bufferedBytes += trailing.byteLength;
      if (bufferedBytes > maximum) throw formatError('archive_line_ceiling', 'Archive line exceeded its byte ceiling.');
      trailing.copy(lineBuffer, bufferedBytes - trailing.byteLength);
    }
  }
  if (bufferedBytes > 0) throw formatError('archive_truncated', 'Archive must end on a complete JSONL record.');
}

function verifyHeaderRecord(record: Record<string, unknown>, expected: LedgerArchiveHeaderInput): void {
  assertExactKeys(record, [
    'ledgerFamily', 'lowerInclusive', 'sourceKeyComparator', 'sourceKeyKind',
    'sourceRelation', 'sourceScope', 'type', 'upperExclusive', 'version',
  ], 'archive_header_mismatch');
  if (record.type !== 'known-ledger-archive' || record.version !== 1
      || record.ledgerFamily !== expected.ledgerFamily || record.sourceRelation !== expected.sourceRelation
      || record.sourceScope !== expected.sourceScope || record.sourceKeyKind !== 'bigint'
      || record.sourceKeyComparator !== 'signed-bigint-ascending-v1'
      || record.lowerInclusive !== expected.lowerInclusive.toString()
      || record.upperExclusive !== expected.upperExclusive.toString()) {
    throw formatError('archive_header_mismatch', 'Archive header does not match the requested segment.');
  }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw formatError(code, 'Archive record schema is invalid.');
  }
}

function validateHeader(header: LedgerArchiveHeaderInput): void {
  if (header.lowerInclusive >= header.upperExclusive) throw formatError('archive_bounds_invalid', 'Archive bounds are invalid.');
  for (const value of [header.ledgerFamily, header.sourceRelation, header.sourceScope]) {
    if (typeof value !== 'string' || value.length === 0) throw formatError('archive_header_invalid', 'Archive header text is invalid.');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw formatError('archive_record_invalid', 'Archive record must be an object.');
  }
  return value as Record<string, unknown>;
}

function parseCanonicalBigint(value: unknown, code: string): bigint {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw formatError(code, 'Archive bigint encoding is invalid.');
  }
  return BigInt(value);
}

function formatError(code: string, message: string, cause?: unknown): LedgerArchiveFormatError {
  return new LedgerArchiveFormatError(code, message, cause);
}
