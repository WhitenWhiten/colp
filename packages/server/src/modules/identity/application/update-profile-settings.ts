import { IdentityError, assertSameOriginAvatarUrl, assertValidAbout, assertValidDisplayName } from '../domain/index.js';
import type { AccountWithProfile } from '../domain/types.js';
import { claimHandle } from './handle.js';
import type { IdentityPorts } from './ports.js';

export interface UpdateProfileSettingsInput {
  readonly accountId: string;
  readonly handle: string;
  readonly displayName: string;
  /**
   * Exact product origin (PRODUCT_ORIGIN). Manually set avatar URLs are
   * restricted to same-origin /api/v1/avatar/<uuid> URLs (avatar audit #6).
   */
  readonly productOrigin: string;
  /**
   * Optional avatar URL update. When the key is present (including null),
   * the stored profile avatar is replaced; when omitted it is preserved.
   */
  readonly avatarUrl?: string | null;
  /**
   * Optional about update. When the key is present (including null), the
   * stored about is replaced; null clears to the empty string. When omitted
   * the stored about is preserved.
   */
  readonly about?: string | null;
}

export async function updateProfileSettings(
  ports: IdentityPorts,
  input: UpdateProfileSettingsInput,
): Promise<AccountWithProfile> {
  const account = await ports.accounts.findById(input.accountId);
  if (!account) throw new IdentityError('account_not_found', 'account was not found');
  if (account.status !== 'active' || account.deletedAt !== null) {
    throw new IdentityError('account_disabled', 'account is not active');
  }
  const profile = await ports.profiles.findByAccountId(input.accountId);
  if (!profile) throw new IdentityError('account_not_found', 'profile was not found');

  const handle = await claimHandle(ports, { accountId: input.accountId, handle: input.handle });
  const displayName = assertValidDisplayName(input.displayName, { allowEmpty: false });
  const avatarUrl = input.avatarUrl === undefined
    ? profile.avatarUrl
    : assertSameOriginAvatarUrl(input.avatarUrl, input.productOrigin);
  const about = input.about === undefined
    ? profile.about
    : input.about === null
      ? ''
      : assertValidAbout(input.about);
  const nextProfile = displayName === profile.displayName
      && avatarUrl === profile.avatarUrl
      && about === profile.about
    ? profile
    : { ...profile, displayName, avatarUrl, about, updatedAt: await ports.clock.now() };
  if (nextProfile !== profile) await ports.profiles.update(nextProfile);
  const identity = await ports.accountIdentities.findByAccountId(input.accountId);
  return { account, profile: nextProfile, handle, identity };
}
