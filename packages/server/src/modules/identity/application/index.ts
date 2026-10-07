export type {
  AccountIdentityRepository,
  AccountRepository,
  IdentityClock,
  IdentityPorts,
  IdentityUnitOfWork,
  OidcLoginTransactionRepository,
  PendingUnboundInvitePurgePort,
  ProfileHandleRepository,
  ProfileRepository,
  SessionRepository,
  VerifiedAccountEmailPort,
  VerifiedActiveAccountByEmail,
} from './ports.js';
export {
  getPublicProfileFacts,
  isCanonicalPublicProfileHandle,
  type PublicProfileFacts,
  type PublicProfileFactsReadPort,
  type PublicProfileOwnerFactsReadPort,
} from './public-profile-read.js';
export {
  EXPLORE_UNKNOWN_CREATOR_ID,
  type ExploreCreatorFacts,
  type ExploreCreatorsQueryPort,
} from './explore-creators-query.js';
export {
  ensureExtensionAccountIdentity,
  type EnsureExtensionAccountIdentityInput,
  type EnsureExtensionAccountIdentityOptions,
} from './ensure-extension-account-identity.js';

export {
  ensureAccountFromOidcIdentity,
  type EnsureAccountFromOidcInput,
} from './ensure-account-from-oidc.js';
export {
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  type CreateOidcLoginTransactionInput,
  type CreateOidcLoginTransactionResult,
} from './oidc-login-transaction.js';
export {
  authenticateSession,
  bootstrapBrowserSession,
  bumpAccountSecurityEpoch,
  createSession,
  revokeSession,
  rotateSession,
  touchSession,
  type AuthenticateSessionOptions,
  type AuthenticatedSession,
  type BootstrapBrowserSessionOptions,
  type BootstrappedBrowserSession,
  type CreateSessionInput,
  type RotateSessionOptions,
} from './session.js';
export {
  claimHandle,
  claimOrReleaseHandle,
  ensureAccountHandle,
  releaseHandle,
  type ClaimHandleInput,
} from './handle.js';
export { updateProfileSettings, type UpdateProfileSettingsInput } from './update-profile-settings.js';
export {
  PROFILE_SETTINGS_COMMAND_ROUTE,
  PROFILE_SETTINGS_COMMAND_SCOPE,
  PROFILE_SETTINGS_CONTRACT_VERSION,
  profileSettingsCommandFingerprint,
  updateProfileSettingsWithReceipt,
  type ProfileSettingsCommandBody,
  type UpdateProfileSettingsCommandInput,
  type UpdateProfileSettingsCommandResult,
} from './update-profile-settings-command.js';
export {
  BOOKMARK_PREFERENCES_CONTRACT_VERSION,
  BOOKMARK_PREFERENCES_ROUTE,
  BookmarkPreferencesError,
  BookmarkPreferencesPreconditionError,
  getBookmarkPreferences,
  parseBookmarkPreferencesPatch,
  updateBookmarkPreferences,
  virtualBookmarkPreferences,
  type BookmarkInsertPosition,
  type BookmarkPreferencesPatch,
  type BookmarkPreferencesPorts,
  type BookmarkPreferencesStore,
  type BookmarkPreferencesView,
  type UpdateBookmarkPreferencesResult,
} from './bookmark-preferences.js';
export {
  assertAvatarImage,
  assertAvatarPrefixesDoNotOverlap,
  avatarUploadBodyFingerprint,
  readAvatarBodyCapped,
  AVATAR_READ_TIMEOUT_MS,
  uploadAvatar,
  prepareAvatarUpload,
  AVATAR_ALLOWED_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarObjectStore,
  type StoredAvatar,
  type UploadAvatarInput,
  type UploadAvatarResult,
} from './avatar-store.js';
export {
  getAccountWithProfile,
  getAccountWithProfileBySubjectId,
} from './get-account-with-profile.js';

import type { IdentityPorts, IdentityUnitOfWork } from './ports.js';
import { ensureAccountFromOidcIdentity, type EnsureAccountFromOidcInput } from './ensure-account-from-oidc.js';
import {
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  type CreateOidcLoginTransactionInput,
} from './oidc-login-transaction.js';
import {
  authenticateSession,
  bootstrapBrowserSession,
  bumpAccountSecurityEpoch,
  createSession,
  revokeSession,
  rotateSession,
  touchSession,
  type AuthenticateSessionOptions,
  type BootstrapBrowserSessionOptions,
  type CreateSessionInput,
  type RotateSessionOptions,
} from './session.js';
import { claimOrReleaseHandle, type ClaimHandleInput, claimHandle, releaseHandle } from './handle.js';
import { updateProfileSettings, type UpdateProfileSettingsInput } from './update-profile-settings.js';
import { getAccountWithProfile, getAccountWithProfileBySubjectId } from './get-account-with-profile.js';

/**
 * Application service factory. Prefer injecting ports from a Unit of Work per call
 * when multiple steps must share one transaction.
 */
export function createIdentityApplication(deps: {
  readonly unitOfWork: IdentityUnitOfWork;
}) {
  const run = <R>(work: (ports: IdentityPorts) => Promise<R>): Promise<R> =>
    deps.unitOfWork.execute(work);

  return {
    ensureAccountFromOidcIdentity: (input: EnsureAccountFromOidcInput) =>
      run((ports) => ensureAccountFromOidcIdentity(ports, input)),
    createOidcLoginTransaction: (input: CreateOidcLoginTransactionInput) =>
      run((ports) => createOidcLoginTransaction(ports, input)),
    consumeOidcLoginTransaction: (state: string) =>
      run((ports) => consumeOidcLoginTransaction(ports, state)),
    createSession: (input: CreateSessionInput) =>
      run((ports) => createSession(ports, input)),
    rotateSession: (
      sessionId: string,
      options?: RotateSessionOptions,
    ) => run((ports) => rotateSession(ports, sessionId, options)),
    bootstrapBrowserSession: (
      rawSessionToken: string,
      options?: BootstrapBrowserSessionOptions,
    ) => run((ports) => bootstrapBrowserSession(ports, rawSessionToken, options)),
    authenticateSession: (rawSessionToken: string, options?: AuthenticateSessionOptions) =>
      run((ports) => authenticateSession(ports, rawSessionToken, options)),
    touchSession: (
      rawSessionToken: string,
      options?: Omit<AuthenticateSessionOptions, 'touch'>,
    ) => run((ports) => touchSession(ports, rawSessionToken, options)),
    revokeSession: (sessionId: string) =>
      run((ports) => revokeSession(ports, sessionId)),
    bumpAccountSecurityEpoch: (accountId: string) =>
      run((ports) => bumpAccountSecurityEpoch(ports, accountId)),
    getAccountWithProfile: (accountId: string) =>
      run((ports) => getAccountWithProfile(ports, accountId)),
    getAccountWithProfileBySubjectId: (subjectId: string) =>
      run((ports) => getAccountWithProfileBySubjectId(ports, subjectId)),
    claimHandle: (input: ClaimHandleInput) =>
      run((ports) => claimHandle(ports, input)),
    updateProfileSettings: (input: UpdateProfileSettingsInput) =>
      run((ports) => updateProfileSettings(ports, input)),
    releaseHandle: (accountId: string) =>
      run((ports) => releaseHandle(ports, accountId)),
    claimOrReleaseHandle: (input: { readonly accountId: string; readonly handle: string | null }) =>
      run((ports) => claimOrReleaseHandle(ports, input)),
  };
}

export type IdentityApplication = ReturnType<typeof createIdentityApplication>;
