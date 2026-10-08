import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { settleBestEffort } from '../async/best-effort.js';
import {
  assertLedgerArchiveObjectKey,
  contentEtag,
  digestFromLedgerArchiveObjectKey,
  LedgerArchiveObjectStoreError,
  normalizeSha256,
  type LedgerArchiveObjectIdentity,
  type LedgerArchiveObjectStore,
} from './object-store.js';

export interface FilesystemLedgerArchiveStoreOptions {
  readonly rootDirectory: string;
  readonly uriBucket?: string;
  /** Development identity recorded in manifests; no encryption claim is made by this adapter. */
  readonly kmsKeyId: string;
}

export function createFilesystemLedgerArchiveObjectStore(
  options: FilesystemLedgerArchiveStoreOptions,
): LedgerArchiveObjectStore {
  const root = resolve(options.rootDirectory);
  const bucket = options.uriBucket ?? 'ledger-archive-development';
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/u.test(bucket)) throw new RangeError('archive_uri_bucket_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9:/_.-]{0,255}$/u.test(options.kmsKeyId)) throw new RangeError('archive_kms_key_id_invalid');

  const pathFor = (key: string): string => {
    assertLedgerArchiveObjectKey(key);
    const object = resolve(root, ...key.split('/'));
    if (!object.startsWith(`${root}${sep}`)) throw new RangeError('archive_key_escaped_root');
    return object;
  };
  const uri = (key: string): string => `s3://${bucket}/${key}`;

  async function head(key: string, signal?: AbortSignal): Promise<LedgerArchiveObjectIdentity> {
    const target = pathFor(key);
    try {
      if (signal?.aborted) throw abortError();
      const facts = await stat(target);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(target, { signal })) {
        hash.update(chunk as Buffer);
      }
      const sha256 = normalizeSha256(hash.digest('hex'));
      if (sha256 !== digestFromLedgerArchiveObjectKey(key)) {
        throw new LedgerArchiveObjectStoreError('corrupt', 'archive_content_address_mismatch', 'Archive object does not match its content address.');
      }
      return Object.freeze({
        key, uri: uri(key), byteLength: BigInt(facts.size), sha256, contentEtag: contentEtag(sha256),
        kmsKeyId: options.kmsKeyId,
      });
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') throw abortError();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LedgerArchiveObjectStoreError('not_found', 'archive_object_not_found', 'Archive object is unavailable.');
      }
      if (error instanceof LedgerArchiveObjectStoreError) throw error;
      throw new LedgerArchiveObjectStoreError('corrupt', 'archive_metadata_corrupt', 'Archive object metadata is corrupt.', error);
    }
  }

  const store: LedgerArchiveObjectStore = {
    uriForKey(key) {
      assertLedgerArchiveObjectKey(key);
      return uri(key);
    },
    head,
    async putCreateOnly(input) {
      const target = pathFor(input.key);
      const expected = normalizeSha256(input.sha256);
      if (expected !== digestFromLedgerArchiveObjectKey(input.key)) {
        throw new LedgerArchiveObjectStoreError('precondition_failed', 'archive_key_digest_mismatch', 'Archive key does not match the declared digest.');
      }
      if (input.kmsKeyId !== options.kmsKeyId) {
        throw new LedgerArchiveObjectStoreError('configuration', 'archive_kms_key_mismatch', 'Archive KMS identity does not match the store.');
      }
      await mkdir(dirname(target), { recursive: true });
      const temporary = join(dirname(target), `.${randomUUID()}.spool`);
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        const hash = createHash('sha256');
        let written = 0n;
        for await (const chunk of input.body) {
          if (input.signal?.aborted) throw abortError();
          hash.update(chunk);
          written += BigInt(chunk.byteLength);
          await handle.write(chunk);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        const actual = `sha256:${hash.digest('hex')}`;
        if (written !== input.byteLength || actual !== expected) {
          throw new LedgerArchiveObjectStoreError(
            'precondition_failed', 'archive_content_binding_mismatch', 'Archive bytes do not match the declared identity.',
          );
        }
        try {
          // link(2) is atomic and fails if the destination exists; rename(2) would overwrite.
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new LedgerArchiveObjectStoreError(
              'already_exists', 'archive_object_exists', 'Archive object already exists.', error,
            );
          }
          throw error;
        }
        const directory = await open(dirname(target), 'r');
        await directory.sync();
        await directory.close();
        return await head(input.key, input.signal);
      } catch (error) {
        if (error instanceof LedgerArchiveObjectStoreError) throw error;
        throw new LedgerArchiveObjectStoreError('unknown', 'archive_filesystem_write_failed', 'Archive object write failed.', error);
      } finally {
        if (handle) await settleBestEffort(handle.close(), 'the authoritative write failure is already preserved');
        await settleBestEffort(unlink(temporary), 'an unlinked private spool is secondary to the immutable object outcome');
      }
    },
    async read(input) {
      const identity = await head(input.key, input.signal);
      if (identity.byteLength > input.byteCeiling) {
        throw new LedgerArchiveObjectStoreError('overflow', 'archive_read_ceiling_exceeded', 'Archive object exceeds the read ceiling.');
      }
      const target = pathFor(input.key);
      const body = boundedFileBody(target, identity.byteLength, input.byteCeiling, input.signal);
      return Object.freeze({ identity, body, async close() { await body.return(undefined); } });
    },
  };
  return Object.freeze(store);
}

async function* boundedFileBody(
  path: string, expected: bigint, ceiling: bigint, signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024, signal });
  let bytes = 0n;
  try {
    for await (const value of stream) {
      const chunk = value as Buffer;
      bytes += BigInt(chunk.byteLength);
      if (bytes > ceiling) {
        stream.destroy();
        throw new LedgerArchiveObjectStoreError('overflow', 'archive_read_ceiling_exceeded', 'Archive read exceeded its byte ceiling.');
      }
      yield chunk;
    }
    if (bytes !== expected) {
      throw new LedgerArchiveObjectStoreError('corrupt', 'archive_object_truncated', 'Archive object was truncated.');
    }
  } catch (error) {
    if (signal?.aborted || (error as Error).name === 'AbortError') throw abortError();
    if (error instanceof LedgerArchiveObjectStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LedgerArchiveObjectStoreError('not_found', 'archive_object_not_found', 'Archive object is unavailable.', error);
    }
    throw new LedgerArchiveObjectStoreError('retryable', 'archive_read_failed', 'Archive object read failed.', error);
  }
}

function abortError(): LedgerArchiveObjectStoreError {
  return new LedgerArchiveObjectStoreError('aborted', 'archive_operation_aborted', 'Archive operation was aborted.');
}
