import { createHash, randomUUID } from 'node:crypto';
import { Readable, addAbortSignal } from 'node:stream';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import { IdentityError, assertValidAvatarUrl } from '../domain/index.js';
import type { AccountWithProfile, ProfileHandle } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';

export const AVATAR_READ_TIMEOUT_MS = 5_000;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ALLOWED_CONTENT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const AVATAR_UPLOAD_CONTRACT_VERSION = '1.0.0';

/** Command receipt scope for profile avatar uploads (per account). */
const AVATAR_UPLOAD_COMMAND_SCOPE = 'avatar:upload';
/** Route used to fingerprint avatar upload commands (must match the transport route). */
const AVATAR_UPLOAD_COMMAND_ROUTE = '/api/v1/me/avatar';

/**
 * Bootstrap-time guard: the public avatar object prefix must never overlap the
 * private attachments live/probe prefixes (all three share the same R2 bucket).
 * Overlap semantics match assertAttachmentsFeatureConfig: equality or a
 * string-prefix relation in either direction is rejected.
 */
export function assertAvatarPrefixesDoNotOverlap(
  avatarPrefix: string,
  livePrefix: string,
  probePrefix: string,
): void {
  const overlaps = (a: string, b: string): boolean =>
    a === b || a.startsWith(b) || b.startsWith(a);
  if (overlaps(avatarPrefix, livePrefix) || overlaps(avatarPrefix, probePrefix)) {
    throw new RangeError(
      `avatar prefix ${JSON.stringify(avatarPrefix)} must not overlap ATTACHMENTS_R2_LIVE_PREFIX or ATTACHMENTS_R2_PROBE_PREFIX `
      + `(live ${JSON.stringify(livePrefix)}, probe ${JSON.stringify(probePrefix)})`,
    );
  }
}

export interface StoredAvatar {
  readonly contentType: string;
  readonly body: Buffer;
}

export interface AvatarObjectStore {
  put(avatarId: string, body: Buffer, contentType: string, accountId?: string, signal?: AbortSignal): Promise<void>;
  /** A single budget covers provider headers, retries, and the entire body. */
  get(avatarId: string, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<StoredAvatar | null>;
  /** Best-effort removal of a stored avatar object. */
  delete(avatarId: string, signal?: AbortSignal): Promise<void>;
  /** Optional owned-client shutdown; in-memory/test stores own no client. */
  close?(): Promise<void>;
}

export interface UploadAvatarInput {
  readonly accountId: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly productOrigin: string;
  readonly commandId: string;
}

export type UploadAvatarResult =
  | { readonly kind: 'created'; readonly account: AccountWithProfile['account']; readonly profile: AccountWithProfile['profile']; readonly handle: AccountWithProfile['handle']; readonly identity: AccountWithProfile['identity'] }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export function assertAvatarImage(body: Buffer, contentType: string): void {
  if (!AVATAR_ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new IdentityError('invalid_identity_input', `avatar content type must be one of ${AVATAR_ALLOWED_CONTENT_TYPES.join(', ')}`);
  }
  if (body.byteLength === 0) {
    throw new IdentityError('invalid_identity_input', 'avatar image body cannot be empty');
  }
  if (body.byteLength > AVATAR_MAX_BYTES) {
    throw new IdentityError('invalid_identity_input', `avatar image must be at most ${AVATAR_MAX_BYTES} bytes`);
  }
  const matches = contentType === 'image/png'
    ? body.byteLength >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : contentType === 'image/jpeg'
      ? body.byteLength >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : contentType === 'image/webp'
        ? body.byteLength >= 12
          && body.subarray(0, 4).toString('ascii') === 'RIFF'
          && body.subarray(8, 12).toString('ascii') === 'WEBP'
        : false;
  if (!matches) {
    throw new IdentityError('invalid_identity_input', `avatar body does not match declared ${contentType}`);
  }
}

/**
 * SHA-256 hex digest of the avatar upload body, used as the `body` field of
 * `canonicalCommandFingerprint`. Passing `body.toString('hex')` allocated ~2×
 * the upload; a 64-char digest keeps the fingerprint payload bounded.
 *
 * In-flight receipts computed with the previous hex-encoded body string may
 * mismatch until they expire (receipt TTL). That is acceptable.
 */
export function avatarUploadBodyFingerprint(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function destroyAvatarReadStream(stream: Readable): void {
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // Socket teardown is best-effort; the caller still treats the object as missing.
  }
}

/**
 * Consume a Node Readable into a Buffer, aborting as soon as `maxBytes + 1`
 * arrives. Peak retained bytes stay O(maxBytes + one chunk); the overflowing
 * chunk is not concatenated. Destroy the source on overflow so HTTP sockets
 * are not held open. Empty bodies return null (avatars cannot be empty).
 */
export async function readAvatarBodyCapped(
  stream: Readable,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (signal) addAbortSignal(signal, stream);
  const collected: Buffer[] = [];
  let total = 0;
  let oversized = false;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + buf.byteLength > maxBytes) {
        oversized = true;
        destroyAvatarReadStream(stream);
        break;
      }
      collected.push(buf);
      total += buf.byteLength;
    }
  } catch (error) {
    if (oversized) return null;
    destroyAvatarReadStream(stream);
    throw error;
  } finally { destroyAvatarReadStream(stream); }
  if (oversized) return null;
  if (total === 0) return null;
  return Buffer.concat(collected, total);
}

/** Prepare recoverable bytes before entering the profile/receipt transaction. */
export async function prepareAvatarUpload(avatars: AvatarObjectStore, input: UploadAvatarInput): Promise<string> {
  assertAvatarImage(input.body, input.contentType);
  try { assertCanonicalCommandId(input.commandId); }
  catch { throw new IdentityError('invalid_identity_input', 'commandId must be a canonical UUID v4.'); }
  // Preparation is recoverable independently of command admission. A receipt
  // replay may leave these bytes unreferenced; persistent orphan GC handles it.
  const avatarId = randomUUID();
  assertValidAvatarUrl(`${input.productOrigin.replace(/\/+$/u, '')}/api/v1/avatar/${avatarId}`);
  await avatars.put(avatarId, input.body, input.contentType, input.accountId);
  return avatarId;
}

export async function uploadAvatar(
  ports: IdentityPorts,
  input: UploadAvatarInput & { readonly preparedAvatarId: string },
): Promise<UploadAvatarResult> {
  const account = await ports.accounts.findById(input.accountId);
  if (!account) throw new IdentityError('account_not_found', 'account was not found');
  if (account.status !== 'active' || account.deletedAt !== null) {
    throw new IdentityError('account_disabled', 'account is not active');
  }
  const profile = await ports.profiles.findByAccountId(input.accountId);
  if (!profile) throw new IdentityError('account_not_found', 'profile was not found');
  assertAvatarImage(input.body, input.contentType);

  const handle = await ports.handles.findByAccountId(input.accountId);
  const identity = await ports.accountIdentities.findByAccountId(input.accountId);
  // The success response embeds the handle; without it the upload cannot be
  // replayed faithfully, so treat a missing handle like a missing profile and
  // fail before any claim/object write (the receipt claim rolls back with the
  // transaction and a later retry can still succeed).
  if (!handle) throw new IdentityError('account_not_found', 'profile was not found');

  let commandId: string;
  try { commandId = assertCanonicalCommandId(input.commandId); }
  catch { throw new IdentityError('invalid_identity_input', 'commandId must be a canonical UUID v4.'); }
  const binding: ProductCommandBinding = {
    principalId: input.accountId,
    commandScope: AVATAR_UPLOAD_COMMAND_SCOPE,
    commandId,
  };
  // Digest the raw bytes instead of body.toString('hex') (which allocated ~2×
  // the upload). In-flight receipts that still store the old hex fingerprint
  // may mismatch until they expire (receipt TTL); that is acceptable.
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST', route: AVATAR_UPLOAD_COMMAND_ROUTE, mediaType: input.contentType,
    body: avatarUploadBodyFingerprint(input.body),
  });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapUploadAvatarClaim(claim);

  const avatarId = input.preparedAvatarId;
  if (!/^[a-f0-9-]{36}$/u.test(avatarId)) throw new IdentityError('invalid_identity_input', 'Invalid prepared avatar id.');
  // Validate the public URL BEFORE writing the object: an invalid
  // productOrigin must never leave an unreferenced object in the store.
  const avatarUrl = assertValidAvatarUrl(`${input.productOrigin.replace(/\/+$/u, '')}/api/v1/avatar/${avatarId}`);
  const nextProfile = {
    ...profile,
    avatarUrl,
    updatedAt: await ports.clock.now(),
  };
  await ports.profiles.update(nextProfile);
  // The profile trigger schedules old-object cleanup in this transaction.
  // Prepared orphans remain recoverable if profile, receipt or COMMIT fails.

  const result = productResult({ account, profile: nextProfile, handle, identity, avatarId });
  await ports.receipts.complete(binding, fingerprint, result);
  return { kind: 'created', account, profile: nextProfile, handle, identity };
}

function mapUploadAvatarClaim(
  claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>,
): UploadAvatarResult {
  if (claim.kind === 'replay') return { kind: 'replay', result: claim.result };
  if (claim.kind === 'in_progress') return claim;
  if (claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}

/**
 * Byte-identical mirror of the transport `toMeView` shape so a command replay
 * returns exactly the bytes the original request produced.
 */
function meViewJson(input: {
  readonly account: AccountWithProfile['account'];
  readonly profile: AccountWithProfile['profile'];
  readonly handle: ProfileHandle;
  readonly identity: AccountWithProfile['identity'];
}): Record<string, unknown> {
  return {
    account: { id: input.account.id, email: input.account.email },
    profile: {
      id: input.account.id,
      handle: input.handle.handle,
      displayName: input.profile.displayName || input.handle.handle,
      avatarUrl: input.profile.avatarUrl,
      about: input.profile.about,
    },
  };
}

function productResult(input: {
  readonly account: AccountWithProfile['account'];
  readonly profile: AccountWithProfile['profile'];
  readonly handle: ProfileHandle;
  readonly identity: AccountWithProfile['identity'];
  readonly avatarId: string;
}): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(meViewJson(input)), 'utf8'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: AVATAR_UPLOAD_CONTRACT_VERSION,
    targetIdentity: input.avatarId,
  };
}
