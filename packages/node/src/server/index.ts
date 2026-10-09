import { randomBytes as secureRandomBytes } from 'node:crypto';

export * from './json.js';
export * from './annotation-provenance.js';
export * from './node-mutation-policy.js';
export * from './node-write-guard.js';
export * from './parent-cycle-guard.js';
export * from './publication-cache-policy.js';
export * from './publication-deleted-collection.js';
export * from './publication-collection-metadata-links.js';
export * from './publication-authorized-directory.js';
export * from './publication-directory.js';
export * from './publication-discovery.js';
export * from './publication-endpoints.js';
export * from './publication-manifest-discovery.js';
export * from './publication-discovery-links.js';
export * from './publication-mount-declarations.js';
export * from './publication-problems.js';
export * from './publication-http-utf8.js';
export * from './publication-http-headers.js';
export * from './publication-http-read.js';
export * from './publication-http-read-request.js';
export * from './publication-version-negotiation.js';
export * from './publication-query.js';
export * from './publication-public-projection.js';
export * from './publication-anonymous-visibility.js';
export * from './publication-bookmark-url-guard.js';
export {
  validatePublicationEndpointDto,
  validatePublicationEndpointQuery,
  validatePublicationEndpointRequest,
  validatePublicationEndpointResponse,
  type PublicationEndpointDtoValidationOptions,
} from '../client/publication-endpoint-dto.js';
export * from './publication-representation-etag.js';
export * from './publication-conditional-get.js';
export * from './publication-snapshot-cursor.js';
export * from './publication-directory-cursor.js';
export * from './publication-snapshot-next-link.js';
export * from './publication-snapshot-page-series.js';
export * from './publication-snapshot-delivery-policy.js';
export * from './publication-static-manifest-profiles.js';
export * from './publication-static-endpoints.js';
export * from './problems.js';
export {
  createProfileIdHmacKey,
  createHmacProfileId,
  createRandomProfileId,
  type HmacProfileIdOptions,
  type ProfileIdHmacKey,
  type ProfileIdRandomBytes,
  type RandomProfileIdOptions,
} from './profile-id.js';
export * from './query.js';
export * from './write.js';
export * from '../semantic/annotation-provenance.js';
export * from '../shared/server-id-reservations.js';
export * from '../shared/resource-identity.js';
export * from '../shared/url-hash.js';
export {
  validateBookmarkUrlHashSemantics,
  validateNodeCreateRequestUrlHashSemantics,
  validateNodeCreateUrlHashSemantics,
  validateNodeMergePatchUrlHashSemantics,
  validateNodeUrlHashSemantics,
} from '../semantic/bookmark-url-hash.js';
export { validateEndpointVariables as validateServerEndpointVariables } from '../semantic/endpoint-contracts.js';

export interface RequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly now: Date;
}

export interface Transaction {
  readonly id: string;
}

export interface TransactionManager {
  run<Result>(work: (transaction: Transaction) => Promise<Result>): Promise<Result>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuidV7(): string;
}

/** Random byte provider compatible with Node.js `crypto.randomBytes`. */
export type RandomBytes = (length: number) => Uint8Array;

export interface UuidV7GeneratorOptions {
  readonly clock?: Clock;
  readonly randomBytes?: RandomBytes;
}

const MAX_UUID_TIMESTAMP = 0xffff_ffff_ffff;
const RANDOM_BITS = 74n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;
const RAND_B_MASK = (1n << 62n) - 1n;
const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

const systemClock: Clock = {
  now: () => new Date(),
};

const systemRandomBytes: RandomBytes = secureRandomBytes;

/**
 * Stateful RFC 9562 UUIDv7 generator.
 *
 * The 74 random bits are incremented for calls in the same millisecond and
 * while the wall clock is behind the last observed time. This preserves
 * ordering and uniqueness within a generator without weakening the random
 * seed used across processes.
 */
export class UuidV7Generator implements IdGenerator {
  readonly #clock: Clock;
  readonly #randomBytes: RandomBytes;
  #lastTimestamp = -1;
  #lastRandom = 0n;

  constructor(options: UuidV7GeneratorOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#randomBytes = options.randomBytes ?? systemRandomBytes;
  }

  uuidV7(): string {
    const wallTimestamp = this.#readTimestamp();
    let timestamp: number;
    let random: bigint;

    if (wallTimestamp > this.#lastTimestamp) {
      timestamp = wallTimestamp;
      random = this.#random74();
    } else if (this.#lastRandom < RANDOM_MASK) {
      timestamp = this.#lastTimestamp;
      random = this.#lastRandom + 1n;
    } else {
      if (this.#lastTimestamp === MAX_UUID_TIMESTAMP) {
        throw new RangeError('UUIDv7 timestamp and random space exhausted.');
      }
      timestamp = this.#lastTimestamp + 1;
      random = this.#random74();
    }

    this.#lastTimestamp = timestamp;
    this.#lastRandom = random;
    return formatUuidV7(timestamp, random);
  }

  #readTimestamp(): number {
    const now = this.#clock.now();
    if (!(now instanceof Date)) {
      throw new TypeError('UUIDv7 clock must return a valid Date.');
    }
    const timestamp = now.getTime();
    if (!Number.isSafeInteger(timestamp)) {
      throw new TypeError('UUIDv7 clock must return a valid Date with an integer Unix-millisecond value.');
    }
    if (timestamp < 0 || timestamp > MAX_UUID_TIMESTAMP) {
      throw new RangeError('UUIDv7 clock must return a valid date within the 48-bit Unix millisecond range.');
    }
    return timestamp;
  }

  #random74(): bigint {
    const bytes = this.#randomBytes(10);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 10) {
      throw new TypeError('UUIDv7 randomBytes must return exactly 10 bytes.');
    }

    // Keep the 12 rand_a bits and 62 rand_b bits that remain after setting
    // the version and variant in a conventional 10-byte random UUID tail.
    let value = BigInt(bytes[0]! & 0x0f);
    value = (value << 8n) | BigInt(bytes[1]!);
    value = (value << 6n) | BigInt(bytes[2]! & 0x3f);
    for (let index = 3; index < bytes.length; index += 1) {
      value = (value << 8n) | BigInt(bytes[index]!);
    }
    return value;
  }
}

/** Process-wide production generator for newly allocated protocol object IDs. */
export const defaultIdGenerator: IdGenerator = new UuidV7Generator();

/** Allocate an ID with the process-wide production UUIDv7 generator. */
export function uuidV7(): string {
  return defaultIdGenerator.uuidV7();
}

function formatUuidV7(timestamp: number, random: bigint): string {
  const bytes = new Uint8Array(16);
  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }

  const randA = random >> 62n;
  const randB = random & RAND_B_MASK;
  bytes[6] = 0x70 | Number(randA >> 8n);
  bytes[7] = Number(randA & 0xffn);
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  for (let index = 15, value = randB; index >= 9; index -= 1, value >>= 8n) {
    bytes[index] = Number(value & 0xffn);
  }

  const hex = Array.from(bytes, (byte) => HEX[byte]);
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10).join('')}`;
}
