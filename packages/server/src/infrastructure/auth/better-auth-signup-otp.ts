import { timingSafeEqual } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { sha256Base64Url } from '../../modules/auth/index.js';

export const ALREADY_REGISTERED_SIGNUP_ERROR = Object.freeze({
  code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  message: 'User already exists. Use another email.',
});

const INVALID_OTP_ERROR = Object.freeze({
  code: 'INVALID_OTP',
  message: 'Invalid OTP',
});

const OTP_EXPIRED_ERROR = Object.freeze({
  code: 'OTP_EXPIRED',
  message: 'OTP expired',
});

const TOO_MANY_ATTEMPTS_ERROR = Object.freeze({
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Too many attempts',
});

const SIGN_IN_OTP_IDENTIFIER_PREFIX = 'sign-in-otp-';

/**
 * P2: BA `disableSignUp` skips sign-in OTP delivery when no user exists.
 * Register send has already confirmed the mailbox is unoccupied; wrap
 * findUserByEmail for this request only so BA still mints + delivers the
 * hashed OTP. The dummy is never persisted.
 */
export function applySignupOtpSendDeliveryToAdapter(context: { internalAdapter: unknown }): void {
  const adapter = context.internalAdapter as {
    findUserByEmail: (email: string) => Promise<{
      readonly user: { readonly id: string };
    } | null>;
  };
  const findUserByEmail = adapter.findUserByEmail.bind(adapter);
  context.internalAdapter = new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'findUserByEmail') {
        return async (email: string) => {
          const found = await findUserByEmail(email);
          if (found?.user) return found;
          return { user: { id: 'known-signup-otp-send' } };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function splitStoredOtpValue(value: string): { readonly hash: string; readonly attempts: string } {
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { hash: value, attempts: '' };
  return { hash: value.slice(0, idx), attempts: value.slice(idx + 1) };
}

function hashedOtpMatches(storedHash: string, otp: string): boolean {
  const expected = sha256Base64Url(otp);
  const left = Buffer.from(storedHash);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * P2: `disableSignUp` makes BA refuse unknown-email `/sign-in/email-otp`.
 * Register verify carries the signup intent header and is the explicit
 * create path: consume the sign-in OTP, mint a verified user + session.
 * Without the header this hook does not run (login stays non-creating).
 */
export async function completeExplicitSignupEmailOtp(
  ctx: {
    readonly body?: unknown;
    readonly json: (data: unknown) => unknown;
    readonly context: { readonly internalAdapter: unknown };
  },
  otpMaxAttempts: number,
): Promise<unknown> {
  const adapter = ctx.context.internalAdapter as {
    findUserByEmail: (email: string) => Promise<{ readonly user: { readonly id: string } } | null>;
    createUser: (user: {
      readonly email: string;
      readonly name: string;
      readonly emailVerified?: boolean;
      readonly image?: string | null;
    }) => Promise<{
      readonly id: string;
      readonly email: string;
      readonly emailVerified: boolean;
      readonly name: string;
      readonly image?: string | null;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }>;
    createSession: (userId: string) => Promise<{
      readonly id: string;
      readonly token: string;
      readonly userId: string;
      readonly expiresAt: Date;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }>;
    findVerificationValue: (identifier: string) => Promise<{
      readonly value: string;
      readonly expiresAt: Date;
    } | null>;
    consumeVerificationValue: (identifier: string) => Promise<{
      readonly value: string;
      readonly expiresAt: Date;
    } | null>;
    deleteVerificationByIdentifier: (identifier: string) => Promise<unknown>;
    createVerificationValue: (data: {
      readonly value: string;
      readonly identifier: string;
      readonly expiresAt: Date;
    }) => Promise<unknown>;
  };
  const body = ctx.body as { email?: unknown; otp?: unknown; name?: unknown; image?: unknown } | undefined;
  if (typeof body?.email !== 'string' || body.email.length === 0
      || typeof body.otp !== 'string' || body.otp.length === 0) {
    return undefined;
  }
  const email = body.email.trim().toLowerCase();
  // P6: prove mailbox control before revealing occupancy. A wrong or missing
  // OTP yields the same INVALID_OTP outcome for registered and unregistered
  // addresses; only a caller who received the code learns the mailbox is
  // already registered (which they could learn by signing in anyway).
  await consumeSignInOtp(adapter, email, body.otp, otpMaxAttempts);
  const existing = await adapter.findUserByEmail(email);
  if (existing?.user) {
    throw APIError.from('UNPROCESSABLE_ENTITY', ALREADY_REGISTERED_SIGNUP_ERROR);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const image = typeof body.image === 'string' ? body.image : undefined;
  const newUser = await adapter.createUser({
    email,
    emailVerified: true,
    name,
    ...(image === undefined ? {} : { image }),
  });
  const session = await adapter.createSession(newUser.id);
  await setSessionCookie(ctx as Parameters<typeof setSessionCookie>[0], {
    session,
    user: newUser,
  });
  return ctx.json({
    token: session.token,
    user: newUser,
  });
}

async function consumeSignInOtp(
  adapter: {
    findVerificationValue: (identifier: string) => Promise<{
      readonly value: string;
      readonly expiresAt: Date;
    } | null>;
    consumeVerificationValue: (identifier: string) => Promise<{
      readonly value: string;
      readonly expiresAt: Date;
    } | null>;
    deleteVerificationByIdentifier: (identifier: string) => Promise<unknown>;
    createVerificationValue: (data: {
      readonly value: string;
      readonly identifier: string;
      readonly expiresAt: Date;
    }) => Promise<unknown>;
  },
  email: string,
  otp: string,
  otpMaxAttempts: number,
): Promise<void> {
  const identifier = `${SIGN_IN_OTP_IDENTIFIER_PREFIX}${email}`;
  const existing = await adapter.findVerificationValue(identifier);
  if (existing && existing.expiresAt < new Date()) {
    await adapter.deleteVerificationByIdentifier(identifier);
    throw APIError.from('BAD_REQUEST', OTP_EXPIRED_ERROR);
  }
  const consumed = await adapter.consumeVerificationValue(identifier);
  if (!consumed) throw APIError.from('BAD_REQUEST', INVALID_OTP_ERROR);
  const { hash, attempts } = splitStoredOtpValue(consumed.value);
  const usedAttempts = Number.parseInt(attempts || '0', 10);
  if (usedAttempts >= otpMaxAttempts) {
    throw APIError.from('FORBIDDEN', TOO_MANY_ATTEMPTS_ERROR);
  }
  if (!hashedOtpMatches(hash, otp)) {
    await adapter.createVerificationValue({
      value: `${hash}:${usedAttempts + 1}`,
      identifier,
      expiresAt: consumed.expiresAt,
    });
    throw APIError.from('BAD_REQUEST', INVALID_OTP_ERROR);
  }
}

