/**
 * Shared helpers for the T12 real Redis adapter contract suite
 * (plan 12-redis-hot-data-cache-plan.md §6.4 T12, §7.1 adapter-contract layer,
 * §7.2/§7.3 anti-false-positive/negative rules).
 *
 * Pure helpers only: constants, polling, failure classification, the reference
 * CRC16 slot calculator and the two-party start gate. Container/store lifecycle
 * and per-test key scoping stay in the suite that owns the Testcontainers
 * container.
 */
import {
  CACHE_ERROR_CATEGORY,
  CacheStoreError,
} from '../../src/infrastructure/cache/index.js';
import { waitForCondition, waitForRealTime } from './async-test-helpers.js';

/**
 * Test-exclusive Redis image. Defaults to redis:7-alpine (7.x latest in the alpine
 * line); CI may pin a specific version via KNOWN_REDIS_IMAGE (mirrors
 * KNOWN_POSTGRES_IMAGE in scripts/with-postgres.mjs).
 */
export const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
/** Cache key namespace (mirrors production key builder usage, plan §4.1 layout). */
export const ENVIRONMENT = 'test';
export const PROJECTION = 'metadata';
/** A query that already passed normalizeCacheQuery (the production key builder requires it). */
export const NORMALIZED_QUERY = { page: 1 } as const;

export const CONNECT_TIMEOUT_MS = 2_000;
export const COMMAND_TIMEOUT_MS = 200;
export const MAX_RETRIES_PER_REQUEST = 1;

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export function delay(ms: number, reason: string): Promise<void> {
  return waitForRealTime(ms, reason);
}

export function isCacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

/**
 * Poll a predicate until it holds or the deadline passes. Polling is the
 * synchronization primitive for TTL expiry, disconnect detection and recovery;
 * a fixed sleep is never the only oracle (plan §7.3 rule 2/8).
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 25,
): Promise<void> {
  await waitForCondition(predicate, {
    timeoutMs,
    pollIntervalMs: intervalMs,
    description,
  });
}

/**
 * Two-party start gate used to create a real interleaving for the lock race: both
 * participants arrive, then both are released together so the two SET NX PX commands
 * are in flight before either resolves.
 */
export class StartGate {
  private remaining: number;
  private readonly go: Promise<void>;
  private releaseGo!: () => void;

  constructor(participants: number) {
    this.remaining = participants;
    this.go = new Promise<void>((resolve) => {
      this.releaseGo = () => {
        this.remaining -= 1;
        if (this.remaining <= 0) resolve();
      };
    });
  }

  arrive(): void {
    this.releaseGo();
  }

  waitForGo(): Promise<void> {
    return this.go;
  }
}

/**
 * Reference CRC16-CCITT — Redis's cluster slot algorithm (src/crc16.c).
 * Standalone Redis (verified on 6.2/7.0/7.4) rejects `CLUSTER KEYSLOT` with
 * "cluster support disabled", so the same-slot check uses this independent
 * reference over each key's hash tag, which is exactly the anchor Redis
 * hashes. It is deliberately NOT the production key codec (plan §7.2 rule 9
 * permits a clearly-simpler independent reference).
 */
export function crc16Ccitt(input: string): number {
  let crc = 0;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Redis's slot anchor: the content of the first {...} (whole key when none). */
export function clusterHashTag(key: string): string {
  const open = key.indexOf('{');
  const close = open === -1 ? -1 : key.indexOf('}', open + 1);
  return open === -1 || close === -1 ? key : key.slice(open + 1, close);
}

/** Reference slot of a key, mirroring Redis's CLUSTER KEYSLOT on standalone. */
export function referenceClusterSlot(key: string): number {
  return crc16Ccitt(clusterHashTag(key)) % 16_384;
}
