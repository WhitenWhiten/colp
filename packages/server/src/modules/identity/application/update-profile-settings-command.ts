import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  type ProductCommandBinding,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  IdentityError,
  assertSameOriginAvatarUrl,
  assertValidAbout,
  assertValidDisplayName,
  assertValidHandle,
} from '../domain/index.js';
import type { AccountWithProfile, ProfileHandle } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';
import { updateProfileSettings, type UpdateProfileSettingsInput } from './update-profile-settings.js';

/** Command receipt scope for PATCH /api/v1/me profile settings (per account). */
export const PROFILE_SETTINGS_COMMAND_SCOPE = 'profile:settings';
/** Route used to fingerprint profile-settings commands (must match the transport route). */
export const PROFILE_SETTINGS_COMMAND_ROUTE = '/api/v1/me';
export const PROFILE_SETTINGS_CONTRACT_VERSION = '1.0.0';

export type ProfileSettingsCommandBody = {
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl?: string | null;
  readonly about?: string | null;
};

export type UpdateProfileSettingsCommandInput = UpdateProfileSettingsInput & {
  readonly commandId: string;
};

export type UpdateProfileSettingsCommandResult =
  | {
      readonly kind: 'updated';
      readonly account: AccountWithProfile['account'];
      readonly profile: AccountWithProfile['profile'];
      readonly handle: ProfileHandle;
      readonly identity: AccountWithProfile['identity'];
      readonly result: ProductCommandResult;
    }
  | { readonly kind: 'replay'; readonly result: ProductCommandResult }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

/**
 * Canonical fingerprint for one PATCH /me intent. `body` is the parsed
 * settings object (not raw JSON key order); `canonicalCommandFingerprint`
 * runs `canonicalJson` over it.
 */
export function profileSettingsCommandFingerprint(body: ProfileSettingsCommandBody): string {
  return canonicalCommandFingerprint({
    method: 'PATCH',
    route: PROFILE_SETTINGS_COMMAND_ROUTE,
    mediaType: 'application/json',
    body: canonicalProfileSettingsBody(body),
  });
}

export async function updateProfileSettingsWithReceipt(
  ports: IdentityPorts,
  input: UpdateProfileSettingsCommandInput,
): Promise<UpdateProfileSettingsCommandResult> {
  // Domain validation before claim so 422 invalid_handle / invalid_about and
  // 400 avatar URL fail without consuming the command id. Occupancy
  // (handle_taken) still runs inside updateProfileSettings after claim; a
  // thrown IdentityError rolls the claim back with the identity UoW.
  assertValidHandle(input.handle);
  assertValidDisplayName(input.displayName, { allowEmpty: false });
  if (input.avatarUrl !== undefined) {
    assertSameOriginAvatarUrl(input.avatarUrl, input.productOrigin);
  }
  if (input.about !== undefined && input.about !== null) {
    assertValidAbout(input.about);
  }

  const commandId = assertCanonicalCommandId(input.commandId);
  const fingerprint = profileSettingsCommandFingerprint(input);
  const binding: ProductCommandBinding = {
    principalId: input.accountId,
    commandScope: PROFILE_SETTINGS_COMMAND_SCOPE,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const updated = await updateProfileSettings(ports, input);
  if (!updated.handle) throw new IdentityError('account_not_found', 'profile was not found');
  const result = productResult({
    account: updated.account,
    profile: updated.profile,
    handle: updated.handle,
    identity: updated.identity,
  });
  await ports.receipts.complete(binding, fingerprint, result);
  return {
    kind: 'updated',
    account: updated.account,
    profile: updated.profile,
    handle: updated.handle,
    identity: updated.identity,
    result,
  };
}

function canonicalProfileSettingsBody(body: ProfileSettingsCommandBody): ProfileSettingsCommandBody {
  return {
    handle: body.handle,
    displayName: body.displayName,
    ...(body.avatarUrl === undefined ? {} : { avatarUrl: body.avatarUrl }),
    ...(body.about === undefined ? {} : { about: body.about }),
  };
}

function mapClaim(
  claim: Exclude<Awaited<ReturnType<ProductCommandReceiptPort['claim']>>, { kind: 'claimed' }>,
): UpdateProfileSettingsCommandResult {
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
}): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(meViewJson(input)), 'utf8'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: PROFILE_SETTINGS_CONTRACT_VERSION,
  };
}
