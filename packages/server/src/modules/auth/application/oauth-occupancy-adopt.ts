/**
 * P1: verified-OAuth adopt of unverified mailbox occupancy.
 *
 * `disableImplicitLinking` stays true (G1). This helper is the NARROW
 * exception: a Google/GitHub (or test genericOAuth) callback with
 * `email_verified=true` for email E may adopt an existing `auth_users` row
 * for E only while that row is still `emailVerified=false`. A verified local
 * occupancy still refuses (G0 `account_not_linked`).
 *
 * The runtime intercept (infrastructure Better Auth hooks) applies this
 * decision before Better Auth would otherwise refuse the callback. Occupancy
 * that is not an OAuth callback is out of scope.
 *
 * S-01: adopt is a takeover of the mailbox, not a merge with the squatter.
 * The same logical unit must unlink the local password (`providerId ===
 * 'credential'`), revoke every existing session (A3 `revokeAll` / security
 * epoch bridge), then link the verified provider and set `emailVerified`.
 * Better Auth 1.7.1 mints the callback session AFTER `createUser` +
 * `createAccount` return, so revokeAll during adopt cannot delete the new
 * session.
 */

import {
  assertValidAvatarUrl,
  assertValidDisplayName,
  type Profile,
} from '../../identity/index.js';
import type { BusinessAccountPorts, BusinessAccountUnitOfWork } from './business-account-mapping.js';
import type { SecurityEpochBridge } from './security-epoch-bridge.js';
import { withoutProviderLinkEpoch } from './provider-link-epoch.js';

export type OAuthOccupancyAdoptDecision = 'create' | 'adopt' | 'refuse';

export interface OAuthOccupancyAdoptInput {
  /** Existing `auth_users` row for the claimed email, or null when unoccupied. */
  readonly occupancy: { readonly emailVerified: boolean } | null;
  /** Provider `email_verified` claim. Must be strictly true to adopt. */
  readonly providerEmailVerified: boolean;
}

/**
 * Decide how a verified-OAuth callback should treat mailbox occupancy for
 * the same email. Unoccupied → create a new user; unverified occupancy +
 * verified provider → adopt the existing row; every other combination
 * refuses (explicit link from a current session only).
 */
export function decideOAuthOccupancyAdopt(
  input: OAuthOccupancyAdoptInput,
): OAuthOccupancyAdoptDecision {
  if (input.occupancy === null) return 'create';
  if (input.occupancy.emailVerified === true) return 'refuse';
  if (input.providerEmailVerified !== true) return 'refuse';
  return 'adopt';
}

/** Better Auth callback paths (built-in social + genericOAuth plugin). */
export function isOAuthCallbackPath(path: string | undefined): boolean {
  if (path === undefined || path.length === 0) return false;
  return path.startsWith('/callback/')
    || path.startsWith('/oauth2/callback/')
    || path === '/callback/:id'
    || path === '/callback/:providerId'
    || path === '/oauth2/callback/:providerId';
}

/** Same provider id `account-linking.ts` uses for the local password row. */
export const OAUTH_OCCUPANCY_CREDENTIAL_PROVIDER_ID = 'credential';

/** Retryable adopt failure: never a half-linked verified account. */
export class OAuthOccupancyAdoptError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OAuthOccupancyAdoptError';
  }
}

/** BA `auth_accounts` row fields this path reads (1.7.1 `findAccounts`). */
export interface OAuthOccupancyAdoptAccountRow {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
}

/**
 * Better Auth 1.7.1 `internalAdapter` methods used by adopt. `deleteAccount`
 * takes the account *row* primary key (`id`), not `accountId`.
 */
export interface OAuthOccupancyAdoptAdapterPort {
  findAccounts(userId: string): Promise<ReadonlyArray<OAuthOccupancyAdoptAccountRow>>;
  deleteAccount(id: string): Promise<void>;
  linkAccount(account: Record<string, unknown>): Promise<unknown>;
  updateUser(userId: string, data: Record<string, unknown>): Promise<unknown>;
}

/** Side-effects composition wires: mapping lookup + `revokeAll` + profile overlay. */
export interface OAuthOccupancyAdoptedInput {
  readonly authUserId: string;
  readonly providerName: string;
  readonly providerImage: string | null;
}

export interface ExecuteOAuthOccupancyAdoptInput {
  readonly userId: string;
  readonly existingUser: { readonly id: string; readonly emailVerified?: boolean };
  readonly providerUser: {
    readonly name: string;
    readonly emailVerified: boolean;
    readonly image?: string | null;
  };
  readonly account: Record<string, unknown>;
  readonly adapter: OAuthOccupancyAdoptAdapterPort;
  /**
   * Production composition MUST wire this to mapping lookup + `revokeAll`.
   * Optional so unit tests that construct a runtime without an authority still
   * compile; a missing callback fail-closes (throws, does not link).
   */
  readonly onAdopted?: (input: OAuthOccupancyAdoptedInput) => Promise<void>;
}

export interface ExecuteOAuthOccupancyAdoptResult {
  readonly user: { readonly id: string; readonly emailVerified?: boolean };
  readonly account: unknown;
}

function wrapAdoptFailure(message: string, cause: unknown): OAuthOccupancyAdoptError {
  if (cause instanceof OAuthOccupancyAdoptError) return cause;
  return new OAuthOccupancyAdoptError(message, { cause });
}

function providerAccountIdOf(account: Record<string, unknown>): string {
  return String(account.accountId ?? '');
}

function providerIdOf(account: Record<string, unknown>): string {
  return String(account.providerId ?? '');
}

async function deleteCredentialAccounts(
  adapter: OAuthOccupancyAdoptAdapterPort,
  userId: string,
): Promise<void> {
  const rows = await adapter.findAccounts(userId);
  for (const row of rows) {
    if (row.providerId !== OAUTH_OCCUPANCY_CREDENTIAL_PROVIDER_ID) continue;
    if (row.id.length === 0) {
      throw new OAuthOccupancyAdoptError(
        'oauth occupancy adopt cannot identify the credential account',
      );
    }
    await adapter.deleteAccount(row.id);
  }
}

async function compensateUnlinkProvider(
  adapter: OAuthOccupancyAdoptAdapterPort,
  userId: string,
  providerId: string,
  accountId: string,
): Promise<void> {
  if (providerId.length === 0 || accountId.length === 0) return;
  const rows = await adapter.findAccounts(userId);
  for (const row of rows) {
    if (row.providerId !== providerId || row.accountId !== accountId) continue;
    await adapter.deleteAccount(row.id);
  }
}

/**
 * Fail-closed adopt unit: unlink credential → revokeAll (via `onAdopted`) →
 * link provider → `emailVerified: true`. A later-step failure unlinks the
 * just-linked provider and leaves `emailVerified` false so the callback can
 * retry. Missing `onAdopted` throws before any write (no half-link).
 */
export async function executeOAuthOccupancyAdopt(
  input: ExecuteOAuthOccupancyAdoptInput,
): Promise<ExecuteOAuthOccupancyAdoptResult> {
  if (input.onAdopted === undefined) {
    throw new OAuthOccupancyAdoptError(
      'oauth occupancy adopt requires session revoke wiring',
    );
  }

  try {
    await deleteCredentialAccounts(input.adapter, input.userId);
  } catch (error) {
    throw wrapAdoptFailure('oauth occupancy adopt could not invalidate the local password', error);
  }

  const providerImage = input.providerUser.image === undefined ? null : input.providerUser.image;
  try {
    await input.onAdopted({
      authUserId: input.userId,
      providerName: input.providerUser.name,
      providerImage,
    });
  } catch (error) {
    throw wrapAdoptFailure('oauth occupancy adopt could not revoke existing sessions', error);
  }

  const providerId = providerIdOf(input.account);
  const providerAccountId = providerAccountIdOf(input.account);
  let linked: unknown;
  try {
    linked = await withoutProviderLinkEpoch(input.userId, () => input.adapter.linkAccount({
      userId: input.userId,
      providerId: input.account.providerId,
      // Better Auth 1.7 scopes account identity by (issuer, accountId).
      issuer: typeof input.account.issuer === 'string' && input.account.issuer.length > 0
        ? input.account.issuer
        : `local:oauth:${encodeURIComponent(providerId)}`,
      accountId: providerAccountId,
      accessToken: input.account.accessToken,
      refreshToken: input.account.refreshToken,
      idToken: input.account.idToken,
      accessTokenExpiresAt: input.account.accessTokenExpiresAt,
      refreshTokenExpiresAt: input.account.refreshTokenExpiresAt,
      scope: input.account.scope,
    }));
  } catch (error) {
    throw wrapAdoptFailure('oauth occupancy adopt could not link the verified provider', error);
  }

  try {
    const updated = await input.adapter.updateUser(input.userId, {
      emailVerified: true,
      ...(input.providerUser.name.length > 0 ? { name: input.providerUser.name } : {}),
      ...(input.providerUser.image !== undefined ? { image: input.providerUser.image } : {}),
    }) as { readonly id: string; readonly emailVerified?: boolean } | null;
    return {
      user: updated ?? { ...input.existingUser, emailVerified: true },
      account: linked,
    };
  } catch (error) {
    try {
      await compensateUnlinkProvider(input.adapter, input.userId, providerId, providerAccountId);
    } catch (compensateError) {
      throw wrapAdoptFailure(
        'oauth occupancy adopt failed after link and could not compensate',
        new AggregateError([error, compensateError], 'adopt compensation failed'),
      );
    }
    throw wrapAdoptFailure('oauth occupancy adopt could not mark the mailbox verified', error);
  }
}

/**
 * Overlay provider name/image onto *empty* product profile fields and clear
 * a squatter-filled `about`. Does not overwrite a non-empty displayName.
 */
export function nextOAuthOccupancyAdoptProfile(
  profile: Profile,
  provider: { readonly name: string; readonly image: string | null },
  now: Date,
): Profile {
  let displayName = profile.displayName;
  if (displayName.trim().length === 0 && provider.name.trim().length > 0) {
    try {
      displayName = assertValidDisplayName(provider.name, { allowEmpty: true });
    } catch {
      // Keep the empty local field rather than failing adopt on a bad IdP name.
    }
  }
  let avatarUrl = profile.avatarUrl;
  if ((avatarUrl === null || avatarUrl.length === 0)
      && provider.image !== null && provider.image.length > 0) {
    try {
      avatarUrl = assertValidAvatarUrl(provider.image);
    } catch {
      // IdP pictures that fail the strict https contract stay unset.
    }
  }
  const about = profile.about.length > 0 ? '' : profile.about;
  if (displayName === profile.displayName
      && avatarUrl === profile.avatarUrl
      && about === profile.about) {
    return profile;
  }
  return { ...profile, displayName, avatarUrl, about, updatedAt: now };
}

/**
 * Production occupancy-adopted side effects (S-01): mapping lookup, epoch
 * bump + revokeAll via the security-epoch bridge, then profile overlay.
 * Composition and integration tests must share this function so a no-op
 * `occupancyAdopted` holder cannot keep the password-strip tests green.
 */
export function createOAuthOccupancyAdoptedHandler(input: {
  readonly businessAccount: BusinessAccountUnitOfWork;
  readonly securityEpochBridge: SecurityEpochBridge;
}): (event: OAuthOccupancyAdoptedInput) => Promise<void> {
  return async (event) => {
    const accountId = await input.businessAccount.execute(async (ports) => {
      const mapping = await ports.mappings.findByAuthUserId(event.authUserId);
      if (!mapping) {
        throw new Error('oauth occupancy adopt requires a business mapping');
      }
      return mapping.accountId;
    });
    // revokeAll is the single epoch-bump + session-revoke path (S-01). BA
    // 1.7.1 mints the callback session after createUser/createAccount return.
    await input.securityEpochBridge.raiseAccountSecurityEvent('oauth_occupancy_adopt', accountId);
    await input.businessAccount.execute(async (ports) => {
      await overlayOAuthOccupancyAdoptProfile(ports, accountId, {
        name: event.providerName,
        image: event.providerImage,
      });
    });
  };
}

/** Apply {@link nextOAuthOccupancyAdoptProfile} through business-account ports. */
export async function overlayOAuthOccupancyAdoptProfile(
  ports: Pick<BusinessAccountPorts, 'profiles' | 'clock'>,
  accountId: string,
  provider: { readonly name: string; readonly image: string | null },
): Promise<void> {
  const profile = await ports.profiles.findByAccountId(accountId);
  if (!profile) return;
  const now = await ports.clock.now();
  const next = nextOAuthOccupancyAdoptProfile(profile, provider, now);
  if (next === profile) return;
  await ports.profiles.update(next);
}
