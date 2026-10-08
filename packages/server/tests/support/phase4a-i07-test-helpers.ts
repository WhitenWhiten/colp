/**
 * Shared helpers for the P4A-I07 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * It provides deterministic test-driven promise barriers (no random sleeps),
 * an in-memory recording object store (records every HEAD/DELETE so "only the
 * retired key was deleted" and "candidate mismatch sent no DELETE" are
 * provable), deterministic generation identity fixtures, and an isolated
 * runtime that applies the PRODUCTION migration (`202608080000_phase4a_attachments`)
 * instead of a spike schema.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDatabaseRuntime, createUnitOfWork, runMigrations } from '../../src/infrastructure/database/index.js';
import type { DatabaseRuntime, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import { requireTestDatabaseUrl } from './postgres-test-runtime.js';
import type {
  DeleteOutcome,
  HeadOutcome,
} from '../../src/modules/attachments/attachments-ledger-contract.js';

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function keyFor(uuidValue: string): string {
  return `phase4a-i07/${uuidValue}`;
}

export interface GenerationIdentity {
  blobId: string;
  intentId: string;
  generationId: string;
  key: string;
  fingerprint: string;
}

/** Deterministic generation identity for a numbered fixture slot. */
export function identityFor(n: number): GenerationIdentity {
  const blobId = uuidFor(1000 + n);
  const intentId = uuidFor(2000 + n);
  const generationId = uuidFor(3000 + n);
  const key = keyFor(uuidFor(4000 + n));
  return { blobId, intentId, generationId, key, fingerprint: sha256Hex(key) };
}

export interface StoredObject {
  etag: string;
  size: number;
  bytes: Uint8Array;
  metadata: Record<string, string>;
}

export interface RecordingObjectStoreOptions {
  beforeHead?: (candidate: { bucket: string; key: string }) => Promise<HeadOutcome | void>;
  beforeDelete?: (candidate: { bucket: string; key: string }) => Promise<DeleteOutcome | void>;
}

/**
 * In-memory object store that records every HEAD and DELETE so tests can prove
 * the loser sent no wrong DELETE and that retired bytes are confirmed absent
 * while active bytes are preserved.
 */
export class RecordingObjectStore {
  options: RecordingObjectStoreOptions = {};
  readonly objects = new Map<string, StoredObject>();
  readonly headCalls: Array<{ bucket: string; key: string }> = [];
  readonly deleteCalls: Array<{ bucket: string; key: string }> = [];

  seed(key: string, bytes: Uint8Array, metadata: Record<string, string> = {}): void {
    this.objects.set(key, {
      etag: `"etag-${sha256Hex(key).slice(0, 16)}"`,
      size: bytes.byteLength,
      bytes,
      metadata,
    });
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  bytesOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  deletedKeys(): string[] {
    return [...new Set(this.deleteCalls.map((call) => call.key))];
  }

  async head(candidate: { bucket: string; key: string }): Promise<HeadOutcome> {
    this.headCalls.push(candidate);
    const overridden = await this.options.beforeHead?.(candidate);
    if (overridden) return overridden;
    const object = this.objects.get(candidate.key);
    if (!object) return { class: 'not_found' };
    return { class: 'ok', etag: object.etag, size: object.size };
  }

  async deleteExactKey(candidate: { bucket: string; key: string }): Promise<DeleteOutcome> {
    this.deleteCalls.push(candidate);
    const overridden = await this.options.beforeDelete?.(candidate);
    if (overridden) return overridden;
    this.objects.delete(candidate.key);
    return { class: 'deleted' };
  }
}

/**
 * Deterministic promise barrier group. A participant calls
 * `arriveAndWait(name)` (signals arrival, then blocks until the coordinator
 * releases). This is an event-driven barrier, not a random sleep, so
 * winner/loser orderings are fully controlled.
 */
interface BarrierImpl {
  signalArrived(): void;
  waitArrived(expected: number): Promise<void>;
  release(): void;
  go(): Promise<void>;
}

class PromiseBarrierImpl implements BarrierImpl {
  private arrivedCount = 0;
  private arrivedResolvers: Array<() => void> = [];
  private goResolvers: Array<() => void> = [];
  private released = false;

  signalArrived(): void {
    this.arrivedCount += 1;
    for (const resolve of this.arrivedResolvers) resolve();
    this.arrivedResolvers = [];
  }

  async waitArrived(expected: number): Promise<void> {
    if (this.arrivedCount >= expected) return;
    await new Promise<void>((resolve) => {
      this.arrivedResolvers.push(resolve);
    });
  }

  release(): void {
    this.released = true;
    for (const resolve of this.goResolvers) resolve();
    this.goResolvers = [];
  }

  async go(): Promise<void> {
    if (this.released) return;
    await new Promise<void>((resolve) => {
      this.goResolvers.push(resolve);
    });
  }
}

export class BarrierGroup {
  private readonly barriers = new Map<string, PromiseBarrierImpl>();

  private barrier(name: string): PromiseBarrierImpl {
    let barrier = this.barriers.get(name);
    if (!barrier) {
      barrier = new PromiseBarrierImpl();
      this.barriers.set(name, barrier);
    }
    return barrier;
  }

  /** Participant hook: signal arrival at `name`, then block until released. */
  arriveAndWait(name: string): Promise<void> {
    const barrier = this.barrier(name);
    barrier.signalArrived();
    return barrier.go();
  }

  async waitArrived(name: string, expected = 1): Promise<void> {
    await this.barrier(name).waitArrived(expected);
  }

  async waitAllArrived(names: readonly string[], expected = 1): Promise<void> {
    await Promise.all(names.map((name) => this.waitArrived(name, expected)));
  }

  release(name: string): void {
    this.barrier(name).release();
  }

  releaseAll(names: readonly string[]): void {
    for (const name of names) this.release(name);
  }
}

export interface I07MigrationRuntime {
  schema: string;
  databaseUrl: string;
  runtime: DatabaseRuntime;
  /** Close the pool but keep the schema (simulates a process exiting). */
  closeKeepSchema(): Promise<void>;
  /** Close and drop the isolated schema. */
  dropSchema(): Promise<void>;
}

/**
 * Creates an isolated schema, applies the PRODUCTION migration chain to
 * latest, and returns a runtime. Unlike createIsolatedPostgresRuntime, closing
 * does NOT drop the schema, so a restarted process can re-open the same schema.
 */
export async function createI07MigrationRuntime(
  prefix: string,
  options: { maxConnections?: number } = {},
): Promise<I07MigrationRuntime> {
  const databaseUrl = requireTestDatabaseUrl();
  assert.match(prefix, /^[a-z][a-z0-9_]*$/, 'schema prefix must be a safe PostgreSQL identifier fragment');
  const schema = `${prefix}_${randomUUID().replaceAll('-', '_')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`create schema ${schema}`);
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const runtime = createDatabaseRuntime(isolatedUrl.toString(), {
    maxConnections: options.maxConnections ?? 10,
    applicationName: `known-i07-${prefix}`,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 30_000,
  });
  await runMigrations(runtime.db, 'latest');
  let closed = false;
  return {
    schema,
    databaseUrl: isolatedUrl.toString(),
    runtime,
    async closeKeepSchema() {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
    async dropSchema() {
      if (!closed) await runtime.close();
      await administrator.query(`drop schema if exists ${schema} cascade`);
      await administrator.end();
    },
  };
}

/** Narrow unit-of-work adapter: every execute opens a NEW transaction. */
export function i07Uow(runtime: DatabaseRuntime) {
  return {
    execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(runtime.db).execute(({ transaction }) => callback(transaction));
    },
  };
}

export function makeBucket(): string {
  return 'known-i07-production';
}
