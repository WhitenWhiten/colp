import {
  AccountDeletionError,
  AccountLinkingError,
  AccountRecoveryError,
  BrowserSessionAuthenticationError,
  type AccountLinkingErrorCode,
  type ReauthProof,
} from '../../modules/auth/index.js';
import {
  IdentityError,
  type IdentityErrorCode,
  getAccountWithProfile,
} from '../../modules/identity/index.js';
import {
  authenticationRequired,
  productErrorForBrowserSessionFailure,
} from '../session-auth.js';
import { ProductHttpError } from '../product-error.js';
import { productErrorStatus } from '../product-codes.js';

/** Map authority failures: occupancy → 403 verification_required; else 401. */
export function mapBrowserSessionFailure(error: unknown): never {
  if (error instanceof BrowserSessionAuthenticationError) {
    throw productErrorForBrowserSessionFailure(error);
  }
  throw error;
}

export function toUtc(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function toMeView(me: Awaited<ReturnType<typeof getAccountWithProfile>>) {
  if (!me?.handle) throw missingAccountHandle();
  return {
    account: { id: me.account.id, email: me.account.email },
    profile: {
      id: me.account.id,
      handle: me.handle.handle,
      displayName: me.profile.displayName || me.handle.handle,
      avatarUrl: me.profile.avatarUrl,
      about: me.profile.about,
    },
  };
}

function invalidProfileField(
  code: 'invalid_handle' | 'invalid_display_name' | 'invalid_about',
  path: string,
  message: string,
): ProductHttpError {
  return new ProductHttpError({
    statusCode: 422, code, message, recovery: 'user_action',
    fieldErrors: [{ path, code, message }],
  });
}

export function parseProfileSettingsBody(value: unknown): {
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  about?: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProfileField('invalid_handle', '/handle', 'handle and displayName are required');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) =>
    key !== 'handle' && key !== 'displayName' && key !== 'avatarUrl' && key !== 'about')) {
    throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'The request contains unsupported fields.' });
  }
  if (typeof body.handle !== 'string') {
    throw invalidProfileField('invalid_handle', '/handle', 'handle must be a string and cannot be null');
  }
  if (typeof body.displayName !== 'string') {
    throw invalidProfileField('invalid_display_name', '/displayName', 'displayName must be a string');
  }
  if (body.avatarUrl !== undefined && body.avatarUrl !== null && typeof body.avatarUrl !== 'string') {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'avatarUrl must be an https URL string or null.',
      recovery: 'user_action',
      fieldErrors: [{ path: '/avatarUrl', code: 'invalid_request', message: 'avatarUrl must be an https URL string or null.' }],
    });
  }
  if (body.about !== undefined && body.about !== null && typeof body.about !== 'string') {
    throw new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'about must be a string or null.',
      recovery: 'user_action',
      fieldErrors: [{ path: '/about', code: 'invalid_request', message: 'about must be a string or null.' }],
    });
  }
  return {
    handle: body.handle,
    displayName: body.displayName,
    ...(body.avatarUrl === undefined ? {} : { avatarUrl: body.avatarUrl as string | null }),
    ...(body.about === undefined ? {} : { about: body.about as string | null }),
  };
}

const PROFILE_SETTINGS_ERROR_MAP = {
  handle_taken: (error) => new ProductHttpError({ statusCode: productErrorStatus('handle_taken'),
    code: 'handle_taken', message: 'This handle is already taken.', recovery: 'user_action' }),
  invalid_handle: (error) => invalidProfileField('invalid_handle', '/handle', error.message),
  invalid_display_name: (error) => invalidProfileField('invalid_display_name', '/displayName', error.message),
  invalid_about: (error) => invalidProfileField('invalid_about', '/about', error.message),
  account_not_found: () => authenticationRequired(),
  account_disabled: () => authenticationRequired(),
  account_deleted: () => authenticationRequired(),
  identity_conflict: () => 'rethrow',
  handle_not_found: () => 'rethrow',
  invalid_email: () => 'rethrow',
  email_unverified: () => 'rethrow',
  email_conflict: () => 'rethrow',
  invalid_return_to: () => 'rethrow',
  session_not_found: () => 'rethrow',
  session_expired: () => 'rethrow',
  session_revoked: () => 'rethrow',
  session_security_epoch_mismatch: () => 'rethrow',
  transaction_not_found: () => 'rethrow',
  transaction_consumed: () => 'rethrow',
  transaction_expired: () => 'rethrow',
  invalid_identity_input: (error) => new ProductHttpError({
    statusCode: 400,
    code: 'invalid_request',
    message: error.message,
    recovery: 'user_action',
    fieldErrors: [{ path: '/avatarUrl', code: 'invalid_request', message: error.message }],
  }),
} as const satisfies Readonly<Record<IdentityErrorCode,
  (error: IdentityError) => ProductHttpError | 'rethrow'>>;

export function mapProfileSettingsError(error: IdentityError): ProductHttpError {
  const mapped = PROFILE_SETTINGS_ERROR_MAP[error.code](error);
  if (mapped === 'rethrow') throw error;
  return mapped;
}

export function linkingUnavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message: 'Account linking is not available on this deployment.',
    recovery: 'none',
  });
}

export function sessionInventoryUnavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message: 'Session inventory is not available on this deployment.',
    recovery: 'none',
  });
}

function invalidLinkRequest(): ProductHttpError {
  // Fixed non-enumerating message (A4 envelope contract).
  return new ProductHttpError({
    statusCode: 400,
    code: 'invalid_request',
    message: 'The request is invalid.',
    recovery: 'user_action',
  });
}

function parseReauthProof(value: unknown): ReauthProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const proof = value as Record<string, unknown>;
  if (proof.kind === 'password') {
    if (typeof proof.password !== 'string' || proof.password.length === 0) throw invalidLinkRequest();
    return { kind: 'password', password: proof.password };
  }
  if (proof.kind === 'otp') {
    if (
      typeof proof.email !== 'string' || proof.email.length === 0
      || typeof proof.otp !== 'string' || proof.otp.length === 0
    ) {
      throw invalidLinkRequest();
    }
    return { kind: 'otp', email: proof.email, otp: proof.otp };
  }
  throw invalidLinkRequest();
}

export function parseLinkStartBody(value: unknown): {
  readonly providerId: string;
  readonly callbackURL: string;
  readonly errorCallbackURL?: string;
  readonly reauth: ReauthProof;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['providerId', 'callbackURL', 'errorCallbackURL', 'reauth'].includes(key))) {
    throw invalidLinkRequest();
  }
  if (typeof body.providerId !== 'string' || body.providerId.length === 0 || body.providerId.length > 128) {
    throw invalidLinkRequest();
  }
  if (typeof body.callbackURL !== 'string' || body.callbackURL.length === 0) {
    throw invalidLinkRequest();
  }
  if (body.errorCallbackURL !== undefined && typeof body.errorCallbackURL !== 'string') {
    throw invalidLinkRequest();
  }
  return {
    providerId: body.providerId,
    callbackURL: body.callbackURL,
    ...(body.errorCallbackURL === undefined ? {} : { errorCallbackURL: body.errorCallbackURL as string }),
    reauth: parseReauthProof(body.reauth),
  };
}

export function parseUnlinkBody(value: unknown): {
  readonly providerId: string;
  readonly accountId: string;
  readonly reauth: ReauthProof;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['providerId', 'accountId', 'reauth'].includes(key))) {
    throw invalidLinkRequest();
  }
  if (typeof body.providerId !== 'string' || body.providerId.length === 0 || body.providerId.length > 128) {
    throw invalidLinkRequest();
  }
  if (typeof body.accountId !== 'string' || body.accountId.length === 0 || body.accountId.length > 512) {
    throw invalidLinkRequest();
  }
  return {
    providerId: body.providerId,
    accountId: body.accountId,
    reauth: parseReauthProof(body.reauth),
  };
}

export function parseDeleteAccountBody(value: unknown): {
  readonly confirmation: string;
  readonly reauth: ReauthProof;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['confirmation', 'reauth'].includes(key))) {
    throw invalidLinkRequest();
  }
  if (typeof body.confirmation !== 'string' || body.confirmation !== 'DELETE') {
    throw invalidLinkRequest();
  }
  return {
    confirmation: body.confirmation,
    reauth: parseReauthProof(body.reauth),
  };
}

export function parseRecoveryRequestEmail(value: unknown): { readonly email: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'email')) throw invalidLinkRequest();
  if (typeof body.email !== 'string' || body.email.length === 0 || body.email.length > 320) {
    throw invalidLinkRequest();
  }
  return { email: body.email };
}

export function parseOtpResetBody(value: unknown): { readonly email: string; readonly otp: string; readonly newPassword: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['email', 'otp', 'newPassword'].includes(key))) {
    throw invalidLinkRequest();
  }
  if (
    typeof body.email !== 'string' || body.email.length === 0 || body.email.length > 320
    || typeof body.otp !== 'string' || body.otp.length === 0 || body.otp.length > 16
    || typeof body.newPassword !== 'string' || body.newPassword.length < 8
  ) {
    throw invalidLinkRequest();
  }
  return { email: body.email, otp: body.otp, newPassword: body.newPassword };
}

export function parseRevokeSessionByIdBody(value: unknown): { readonly sessionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidLinkRequest();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'sessionId')) throw invalidLinkRequest();
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0 || body.sessionId.length > 128) {
    throw invalidLinkRequest();
  }
  return { sessionId: body.sessionId };
}

/**
 * P7: keep the existing product wire codes (`invalid_credentials` /
 * `invalid_request`) and put operator-facing detail in `message`. Do not add
 * OpenAPI error-code enum members.
 */
const ACCOUNT_LINKING_INVALID_REQUEST_MESSAGES = {
  already_linked: 'This provider is already connected.',
  last_recovery_method: 'Keep at least one sign-in method.',
  invalid_callback_url: 'The return path is not allowed.',
  account_not_found: 'That sign-in method is not connected.',
  provider_not_configured: 'That sign-in provider is not available.',
  link_start_failed: 'We could not start connecting that provider. Try again.',
} as const satisfies Record<Exclude<AccountLinkingErrorCode, 'reauth_failed'>, string>;

/** Map the linking facade failures to the stable product envelope. */
export function mapAccountLinkingError(error: unknown): ProductHttpError {
  if (error instanceof BrowserSessionAuthenticationError) {
    return productErrorForBrowserSessionFailure(error);
  }
  if (error instanceof AccountLinkingError) {
    if (error.code === 'reauth_failed') {
      // Non-enumerating: wrong password/OTP looks exactly like bad credentials.
      return new ProductHttpError({
        statusCode: productErrorStatus('invalid_credentials'),
        code: 'invalid_credentials',
        message: 'The email or password is incorrect.',
        recovery: 'user_action',
      });
    }
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: ACCOUNT_LINKING_INVALID_REQUEST_MESSAGES[error.code],
      recovery: 'user_action',
    });
  }
  throw error;
}

/** Map the P10 deletion facade failures to the stable product envelope. */
export function mapAccountDeletionError(error: unknown): ProductHttpError {
  if (error instanceof BrowserSessionAuthenticationError) {
    return productErrorForBrowserSessionFailure(error);
  }
  if (error instanceof AccountLinkingError) return mapAccountLinkingError(error);
  if (error instanceof AccountDeletionError) {
    if (error.code === 'reauth_failed') {
      return mapAccountLinkingError(
        new AccountLinkingError('reauth_failed', error.message),
      );
    }
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request is invalid.',
      recovery: 'user_action',
    });
  }
  throw error;
}

/** Map the recovery facade failures to the stable product envelope. */
export function mapAccountRecoveryError(error: unknown): ProductHttpError {
  if (error instanceof AccountRecoveryError) {
    if (error.code === 'email_delivery_unavailable') {
      return new ProductHttpError({
        statusCode: productErrorStatus('email_delivery_unavailable'),
        code: 'email_delivery_unavailable',
        message: 'Email delivery is temporarily unavailable. Please try again later.',
        recovery: 'none',
      });
    }
    if (error.code === 'invalid_credentials') {
      return new ProductHttpError({
        statusCode: productErrorStatus('invalid_credentials'),
        code: 'invalid_credentials',
        message: 'The email or password is incorrect.',
        recovery: 'user_action',
      });
    }
    return new ProductHttpError({
      statusCode: 400,
      code: 'invalid_request',
      message: 'The request is invalid.',
      recovery: 'user_action',
    });
  }
  throw error;
}

export function missingAccountHandle(): ProductHttpError {
  return new ProductHttpError({
    statusCode: 503,
    code: 'feature_temporarily_unavailable',
    message: 'The account profile is temporarily unavailable.',
    recovery: 'none',
  });
}
