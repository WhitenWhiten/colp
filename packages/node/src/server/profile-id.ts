import { createHmac, randomBytes as secureRandomBytes } from 'node:crypto';
import type { Hmac } from 'node:crypto';

import { hasWellFormedUtf16 } from '../shared/utf16.js';

const MIN_HMAC_KEY_BYTES = 32;
const MAX_HMAC_KEY_BYTES = 1024;
const MAX_FIELD_BYTES = 4096;
const MAX_LOCAL_PROFILE_KEY_BYTES = 4096;
const PROFILE_ID_CONTEXT = Buffer.from('collection-protocol/profile-id/hmac-sha-256/v1', 'ascii');
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9._~-]{1,77}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const RANDOM_PROFILE_ID_PATTERN = /^prf\.r1\.[A-Za-z0-9_-]{43}$/;

/** Random byte provider compatible with Node.js `crypto.randomBytes`. */
export type ProfileIdRandomBytes = (length: number) => Uint8Array;

export interface RandomProfileIdOptions {
  /** Injectable only for platform adapters and deterministic contract tests. */
  readonly randomBytes?: ProfileIdRandomBytes;
}

/**
 * Durable local storage boundary for one random ID per stable local profile.
 *
 * `getOrCreate` MUST atomically read and, only when absent, invoke `allocate`
 * and insert its exact result under a uniqueness constraint on `localProfileKey`.
 * The operation MUST serialize concurrent first use: a losing caller waits for
 * and reads the committed winner without invoking its allocator. Optimistically
 * allocating before a uniqueness race is not supported by this interface. The
 * Promise MUST resolve only after the winner is durable; rollback or commit
 * uncertainty MUST reject. An adapter MUST NOT retain or invoke `allocate`
 * outside the atomic operation, and MUST NOT send the local key remotely.
 */
export type LocalProfileIdAllocator = () => string;

export interface LocalProfileIdStore {
  getOrCreate(localProfileKey: string, allocate: LocalProfileIdAllocator): Promise<string>;
}

export interface HmacProfileIdOptions {
  /** Opaque server-only key handle. It has no key getter or JSON representation. */
  readonly key: ProfileIdHmacKey;
  /** Public rotation label embedded in the result; it is not key material. */
  readonly keyVersion: string;
  /** Stable identifier for the server deployment; prevents cross-server correlation. */
  readonly serverScope: string;
  /** Stable tenant/account identifier within that server. */
  readonly tenantScope: string;
}

/**
 * Opaque server-owned HMAC key capability.
 *
 * The handle deliberately exposes only lifecycle state. Its key bytes cannot be
 * read, enumerated, inspected, or JSON-serialized through this API.
 */
export interface ProfileIdHmacKey {
  readonly destroyed: boolean;
  destroy(): void;
}

const profileIdHmacKeys = new WeakMap<ProfileIdHmacKey, Buffer>();

class ProfileIdHmacKeyHandle implements ProfileIdHmacKey {
  get destroyed(): boolean {
    return !profileIdHmacKeys.has(this);
  }

  destroy(): void {
    const key = profileIdHmacKeys.get(this);
    if (key === undefined) return;
    profileIdHmacKeys.delete(this);
    key.fill(0);
  }
}

/**
 * Imports caller-owned bytes into an opaque server key capability.
 *
 * The input is copied and remains owned by the caller, which should erase its
 * own buffer after import. Call `destroy()` when this key version is retired.
 */
export function createProfileIdHmacKey(keyMaterial: Uint8Array): ProfileIdHmacKey {
  const key = copyKeyMaterial(keyMaterial);
  const handle = Object.freeze(new ProfileIdHmacKeyHandle());
  profileIdHmacKeys.set(handle, key);
  return handle;
}

/**
 * Allocates a privacy-safe profile ID from 256 CSPRNG bits.
 *
 * This function intentionally has no persistence side effect. The caller MUST
 * durably persist the returned ID with the local profile and reuse it instead of
 * generating a new value on every synchronization.
 */
export function createRandomProfileId(options: RandomProfileIdOptions = {}): string {
  const bytes = (options.randomBytes ?? secureRandomBytes)(32);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new TypeError('Profile ID randomBytes must return exactly 32 bytes.');
  }
  return `prf.r1.${Buffer.from(bytes).toString('base64url')}`;
}

/**
 * Loads the durable random ID for a local profile, allocating it once if absent.
 *
 * Entropy is requested only through the store's atomic create-if-absent callback.
 * Existing values must use the random `prf.r1` envelope; HMAC and generic opaque
 * IDs are deliberately rejected at this random-ID persistence boundary.
 */
export async function getOrCreateRandomProfileId(
  localProfileKey: string,
  store: LocalProfileIdStore,
  options: RandomProfileIdOptions = {},
): Promise<string> {
  assertLocalProfileKey(localProfileKey);
  const getOrCreate = getLocalProfileIdStoreMethod(store);

  const randomBytes = options.randomBytes;
  let allocatorActive = true;
  let allocatorInvocations = 0;
  let allocated: string | undefined;
  const allocate = (): string => {
    if (!allocatorActive) {
      throw new TypeError('Random profile ID allocator cannot be invoked after getOrCreate settles.');
    }
    allocatorInvocations += 1;
    if (allocatorInvocations !== 1) {
      throw new TypeError('Random profile ID store must invoke the allocator at most once.');
    }
    if (randomBytes !== undefined && typeof randomBytes !== 'function') {
      throw new TypeError('Profile ID randomBytes must be a function when provided.');
    }
    allocated = createRandomProfileId(randomBytes === undefined ? {} : { randomBytes });
    return allocated;
  };

  let stored: unknown;
  try {
    const operation = getOrCreate.call(store, localProfileKey, allocate);
    if (!(operation instanceof Promise)) {
      throw new TypeError('Local profile ID store getOrCreate() must return a Promise.');
    }
    stored = await operation;
  } finally {
    allocatorActive = false;
  }

  if (allocatorInvocations > 1) {
    throw new TypeError('Random profile ID store invoked the allocator more than once.');
  }
  assertRandomProfileId(stored);
  if (allocated !== undefined && stored !== allocated) {
    throw new TypeError('Random profile ID store did not return the value allocated by this operation.');
  }
  return stored;
}

/**
 * Derives a server- and tenant-scoped profile ID without disclosing the local ID.
 * String local IDs are NFC-normalized UTF-8; byte local IDs are used exactly.
 */
export function createHmacProfileId(
  localId: string | Uint8Array,
  options: HmacProfileIdOptions,
): string {
  const keyVersionValue = readHmacOption(options, 'keyVersion');
  const keyVersion = encodeKeyVersion(keyVersionValue);
  const serverScope = encodeScope('serverScope', readHmacOption(options, 'serverScope'));
  const tenantScope = encodeScope('tenantScope', readHmacOption(options, 'tenantScope'));
  const key = borrowKey(readHmacOption(options, 'key'));
  let localBytes: Buffer | undefined;

  try {
    const encodedLocalId = encodeLocalId(localId);
    localBytes = encodedLocalId.bytes;
    const mac = createHmac('sha256', key);
    updateFrame(mac, PROFILE_ID_CONTEXT);
    updateFrame(mac, keyVersion);
    updateFrame(mac, serverScope);
    updateFrame(mac, tenantScope);
    mac.update(Uint8Array.of(encodedLocalId.kind));
    updateFrame(mac, localBytes);
    return `prf.h1.${keyVersionValue}.${mac.digest('base64url')}`;
  } finally {
    key.fill(0);
    localBytes?.fill(0);
  }
}

function copyKeyMaterial(value: Uint8Array): Buffer {
  let byteLength: number;
  try {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('Profile ID HMAC key must be a Uint8Array.');
    }
    byteLength = value.byteLength;
  } catch {
    throw new TypeError('Profile ID HMAC key must be a Uint8Array.');
  }
  if (byteLength < MIN_HMAC_KEY_BYTES || byteLength > MAX_HMAC_KEY_BYTES) {
    throw new TypeError(
      `Profile ID HMAC key must contain ${MIN_HMAC_KEY_BYTES}-${MAX_HMAC_KEY_BYTES} bytes.`,
    );
  }
  try {
    return Buffer.from(value);
  } catch {
    throw new TypeError('Profile ID HMAC key could not be copied.');
  }
}

function borrowKey(value: ProfileIdHmacKey): Buffer {
  const stored = profileIdHmacKeys.get(value);
  if (stored === undefined) {
    throw new TypeError('Profile ID HMAC key handle is invalid or destroyed.');
  }
  return Buffer.from(stored);
}

function readHmacOption<Field extends keyof HmacProfileIdOptions>(
  options: HmacProfileIdOptions,
  field: Field,
): HmacProfileIdOptions[Field] {
  try {
    return options[field];
  } catch {
    // Do not propagate a caller-defined accessor error that may carry secrets.
    throw new TypeError('Profile ID HMAC options could not be read.');
  }
}

function getLocalProfileIdStoreMethod(
  value: LocalProfileIdStore,
): LocalProfileIdStore['getOrCreate'] {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    throw new TypeError('Local profile ID store must provide getOrCreate().');
  }
  const getOrCreate = value.getOrCreate;
  if (typeof getOrCreate !== 'function') {
    throw new TypeError('Local profile ID store must provide getOrCreate().');
  }
  return getOrCreate;
}

function assertLocalProfileKey(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !hasWellFormedUtf16(value)
  ) {
    throw new TypeError(
      'Local profile key must be a non-empty, well-formed string without control characters.',
    );
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_LOCAL_PROFILE_KEY_BYTES) {
    throw new RangeError(
      `Local profile key must not exceed ${MAX_LOCAL_PROFILE_KEY_BYTES} UTF-8 bytes.`,
    );
  }
}

function assertRandomProfileId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !RANDOM_PROFILE_ID_PATTERN.test(value)) {
    throw new TypeError('Stored profile ID must be a canonical prf.r1 random profile ID.');
  }
  const encoded = value.slice('prf.r1.'.length);
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) {
    throw new TypeError('Stored profile ID must encode exactly 32 bytes using canonical base64url.');
  }
}

function encodeKeyVersion(value: string): Buffer {
  if (typeof value !== 'string' || !KEY_VERSION_PATTERN.test(value)) {
    throw new TypeError('keyVersion must be 1-77 URI-unreserved ASCII characters.');
  }
  return Buffer.from(value, 'ascii');
}

function encodeScope(name: string, value: string): Buffer {
  if (typeof value !== 'string' || !SCOPE_PATTERN.test(value)) {
    throw new TypeError(`${name} must be 1-128 URI-unreserved ASCII characters.`);
  }
  return Buffer.from(value, 'ascii');
}

function encodeLocalId(value: string | Uint8Array): { readonly kind: number; readonly bytes: Buffer } {
  if (typeof value === 'string') {
    if (value.length === 0 || CONTROL_CHARACTER_PATTERN.test(value) || !hasWellFormedUtf16(value)) {
      throw new TypeError(
        'String local profile ID must be non-empty, well-formed, and contain no control characters.',
      );
    }
    const bytes = Buffer.from(value.normalize('NFC'), 'utf8');
    if (bytes.length > MAX_FIELD_BYTES) {
      throw new RangeError(`Local profile ID must not exceed ${MAX_FIELD_BYTES} UTF-8 bytes.`);
    }
    return { kind: 0x01, bytes };
  }
  let isByteInput: boolean;
  try {
    isByteInput = value instanceof Uint8Array;
  } catch {
    throw new TypeError('Local profile ID must be a string or Uint8Array.');
  }
  if (!isByteInput) {
    throw new TypeError('Local profile ID must be a string or Uint8Array.');
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    throw new TypeError('Local profile ID bytes could not be read.');
  }
  if (length === 0 || length > MAX_FIELD_BYTES) {
    throw new RangeError(`Local profile ID bytes must contain 1-${MAX_FIELD_BYTES} bytes.`);
  }
  try {
    return { kind: 0x02, bytes: Buffer.from(value) };
  } catch {
    throw new TypeError('Local profile ID bytes could not be copied.');
  }
}

function updateFrame(mac: Hmac, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  mac.update(length);
  mac.update(value);
}
