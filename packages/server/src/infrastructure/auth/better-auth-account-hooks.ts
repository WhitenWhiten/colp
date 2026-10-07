import type { Kysely } from 'kysely';
import {
  BROWSER_SESSION_LIVE_CAP,
  BusinessAccountMappingError,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  deriveBrowserSessionCsrfTokenRaw,
  ensureBusinessAccountForVerifiedEmail,
  observeCompletedProviderAccount,
  type AuthEmailSender,
  type BusinessAccountUnitOfWork,
} from '../../modules/auth/index.js';
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  deleteTrustDeviceVerificationsForAuthUser,
  evictOldestLiveBrowserSessions,
} from './better-auth-session-authority.js';
import type { BetterAuthRuntimeInput } from './better-auth-runtime-contract.js';

/**
 * Better Auth post-commit hooks that establish product account mappings and
 * session authority metadata. These hooks deliberately own their database
 * transactions and compensation behavior; runtime construction only wires
 * the returned callbacks into Better Auth.
 */

interface EstablishBusinessAccountParams {
  readonly authUserId: string;
  readonly email: string | null;
  readonly emailProofVerified: boolean;
  readonly allowEmailChange?: boolean;
  readonly displayName?: string;
}
/** Structural subset of the runtime input consumed by the C2 hooks/helpers. */
export interface BetterAuthRuntimeHooksContext {
  readonly authEmail?: AuthEmailSender;
  /** Product origin (no BA basePath) used to rewrite verification links. */
  readonly productOrigin?: string;
  readonly businessAccount?: { readonly unitOfWork: BusinessAccountUnitOfWork };
  /**
   * E3 (plan §4.3.1.4): the runtime database binding used to establish the
   * product session-metadata row right after a BA session commits. The A2
   * unit-of-work ports do not cover the metadata table, so the hook runs a
   * self-managed transaction on the same Kysely binding the adapter uses.
   */
  readonly database?: { readonly db: Kysely<DatabaseSchema> };
  readonly logger?: { warn(bindings: object, message: string): void };
  readonly onPasswordReset?: BetterAuthRuntimeInput<never>['onPasswordReset'];
  readonly onProviderLinked?: BetterAuthRuntimeInput<never>['onProviderLinked'];
}

/**
 * A2 business-account establishment seams. All hooks are idempotent; the
 * post-commit hooks (user/session create.after) and onPasswordReset are
 * GUARDED — a failure must never fail a committed sign-up/sign-in/reset —
 * while afterEmailVerification PROPAGATES (verification completes only when
 * the mapping is established/confirmed, fail-closed).
 */
export function buildBusinessAccountHooks(input: BetterAuthRuntimeHooksContext) {
  const hasEstablishment = input.businessAccount !== undefined;
  return {
    userCreateAfter: hasEstablishment
      ? async (user: { readonly id?: string; readonly email?: string | null; readonly name?: string | null }): Promise<void> => {
          if (typeof user.id !== 'string' || user.id.length === 0) return;
          await guardedEstablishBusinessAccount(input, {
            authUserId: user.id,
            email: typeof user.email === 'string' ? user.email : null,
            emailProofVerified: false,
            displayName: typeof user.name === 'string' ? user.name : undefined,
          });
        }
      : null,
    sessionCreateAfter: hasEstablishment
      ? async (session: { readonly id?: string; readonly token?: string; readonly userId?: string }): Promise<void> => {
          if (typeof session.userId !== 'string' || session.userId.length === 0) return;
          // BA 1.7.1 session.create.after receives the session row (userId,
          // not a nested user). Load email/emailVerified from auth_users so
          // verified OAuth first-login can fill a null accounts.email.
          // Unverified occupancy keeps email: null / emailProofVerified: false.
          // Guarded: must not fail login. Never allowEmailChange (P9 vs session).
          const proof = await loadAuthUserEmailProof(input.database?.db, session.userId);
          const verified = proof.emailVerified && proof.email !== null;
          await guardedEstablishBusinessAccount(input, {
            authUserId: session.userId,
            email: verified ? proof.email : null,
            emailProofVerified: verified,
            allowEmailChange: false,
          });
          // E3 (plan §4.3.1.4): establish the product session-metadata row
          // right after the BA session commits (creation-time epoch;
          // idempotent so rotation/test rows coexist).
          await guardedEstablishSessionMetadata(input, session);
        }
      : null,
    afterEmailVerification: hasEstablishment
      ? async (user: { readonly id?: string; readonly email?: string | null }): Promise<void> => {
          if (typeof user.id !== 'string' || user.id.length === 0) return;
          try {
            await establishBusinessAccount(input, {
              authUserId: user.id,
              email: typeof user.email === 'string' ? user.email : null,
              emailProofVerified: true,
              allowEmailChange: true,
            });
          } catch (error) {
            await compensateAuthUserEmailIfProductUnchanged(input, user.id);
            throw error;
          }
        }
      : null,
    accountCreateAfter: input.onProviderLinked !== undefined && input.database !== undefined
      ? async (account: {
          readonly providerId?: string;
          readonly userId?: string;
          readonly password?: string | null;
        }): Promise<void> => {
          const db = input.database?.db;
          const raise = input.onProviderLinked;
          if (db === undefined || raise === undefined) return;
          await observeCompletedProviderAccount({
            account,
            accountCount: async (userId) => {
              const rows = await db.selectFrom('auth_accounts')
                .select('id')
                .where('userId', '=', userId)
                .execute();
              return rows.length;
            },
            raiseProviderLink: async (authUserId) => {
              await raise({ authUserId });
            },
          });
        }
      : null,
    /**
     * Always wired (not only when business-account establishment is present):
     * BA `/reset-password` and `/email-otp/reset-password` revoke sessions
     * without going through `revokeAll`, so P5 trust-device rows must die here.
     */
    onPasswordReset: async ({ user }: { readonly user: { readonly id?: string; readonly email?: string | null } }): Promise<void> => {
      if (typeof user.id === 'string' && user.id.length > 0 && input.database !== undefined) {
        try {
          await deleteTrustDeviceVerificationsForAuthUser(input.database.db, user.id);
        } catch (error) {
          input.logger?.warn(
            {
              classification: 'trust_device_clear_failed',
              ...(error instanceof Error ? { name: error.name } : {}),
            },
            'trust-device clear failed after password reset',
          );
        }
      }
      const onPasswordReset = input.onPasswordReset;
      if (onPasswordReset !== undefined && typeof user.id === 'string' && user.id.length > 0) {
        try {
          await onPasswordReset({ authUserId: user.id });
        } catch (error) {
          input.logger?.warn(
            {
              classification: 'password_reset_epoch_revoke_failed',
              ...(error instanceof Error ? { name: error.name } : {}),
            },
            'password-reset epoch revoke failed; the password is already reset',
          );
        }
      }
      if (!hasEstablishment) return;
      if (typeof user.id !== 'string' || user.id.length === 0) return;
      await guardedEstablishBusinessAccount(input, {
        authUserId: user.id,
        email: typeof user.email === 'string' ? user.email : null,
        emailProofVerified: false,
      });
    },
  };
}

async function establishBusinessAccount(
  input: BetterAuthRuntimeHooksContext,
  params: EstablishBusinessAccountParams,
): Promise<void> {
  const unitOfWork = input.businessAccount?.unitOfWork;
  if (unitOfWork === undefined) return;
  await ensureBusinessAccountForVerifiedEmail(
    {
      authUserId: params.authUserId,
      email: params.email,
      emailProofVerified: params.emailProofVerified,
      // C2 flows (sign-up / sign-in / reset / verification) are never an
      // explicit link command; adoption requires the verified-email proof.
      explicitLink: false,
      allowEmailChange: params.allowEmailChange === true,
      ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
    },
    { unitOfWork },
  );
}

/** Guarded establishment: redacted warning only, never a thrown auth failure. */
async function guardedEstablishBusinessAccount(
  input: BetterAuthRuntimeHooksContext,
  params: EstablishBusinessAccountParams,
): Promise<void> {
  try {
    await establishBusinessAccount(input, params);
  } catch (error) {
    // Redacted: classification + stable code only — never email/user/OTP
    // material. The mapping is retried on the next session creation.
    input.logger?.warn(
      {
        classification: 'business_account_establishment_failed',
        ...(error instanceof BusinessAccountMappingError ? { code: error.code } : {}),
      },
      'business account establishment failed; it will be retried on the next session creation',
    );
  }
}

/**
 * BA 1.7.1 session.create.after payload is the session row (id/token/userId),
 * not a nested user. Read emailVerified from auth_users on the same Kysely
 * binding the adapter uses.
 */
async function loadAuthUserEmailProof(
  db: Kysely<DatabaseSchema> | undefined,
  userId: string,
): Promise<{ readonly email: string | null; readonly emailVerified: boolean }> {
  if (db === undefined) return { email: null, emailVerified: false };
  try {
    const row = await db.selectFrom('auth_users')
      .select(['email', 'emailVerified'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) return { email: null, emailVerified: false };
    const email = typeof row.email === 'string' && row.email.trim().length > 0 ? row.email : null;
    return { email, emailVerified: row.emailVerified === true };
  } catch {
    return { email: null, emailVerified: false };
  }
}

/**
 * P9 fail-closed compensation: BA already committed the new auth_users.email.
 * If product email is still the previous non-null address, revert auth_users
 * so the two tables do not stay split after a thrown confirm.
 */
async function compensateAuthUserEmailIfProductUnchanged(
  input: BetterAuthRuntimeHooksContext,
  authUserId: string,
): Promise<void> {
  const db = input.database?.db;
  if (db === undefined) return;
  try {
    const mapping = await db.selectFrom('auth_user_account_map')
      .select(['account_id'])
      .where('auth_user_id', '=', authUserId)
      .executeTakeFirst();
    if (!mapping) return;
    const account = await db.selectFrom('accounts')
      .select(['email'])
      .where('id', '=', mapping.account_id)
      .executeTakeFirst();
    const productEmail = typeof account?.email === 'string' ? account.email.trim().toLowerCase() : '';
    if (productEmail.length === 0) return;
    const authUser = await db.selectFrom('auth_users')
      .select(['email'])
      .where('id', '=', authUserId)
      .executeTakeFirst();
    const authEmail = typeof authUser?.email === 'string' ? authUser.email.trim().toLowerCase() : '';
    if (authEmail === productEmail) return;
    await db.updateTable('auth_users')
      .set({ email: productEmail, updatedAt: new Date() })
      .where('id', '=', authUserId)
      .execute();
  } catch (error) {
    input.logger?.warn(
      {
        classification: 'product_email_sync_compensate_failed',
        ...(error instanceof Error ? { name: error.name } : {}),
      },
      'failed to revert auth email after product email sync failure',
    );
  }
}

/**
 * E3 (plan §4.3.1.4): establish the product `known_auth_session_metadata`
 * row for a BA-native session right after the BA session row commits. The
 * row snapshots the session-creation-time security epoch (a later epoch bump
 * must invalidate this session) and the purpose-separated CSRF digest; the
 * insert is idempotent (`on conflict (auth_session_id) do nothing`) so rows
 * minted by the rotation path or by test harnesses coexist unchanged. The
 * mapping must already exist (A2 establishment) — when it does not, the row
 * is skipped and the next session creation heals.
 */
async function establishSessionMetadata(
  input: BetterAuthRuntimeHooksContext,
  session: { readonly id?: string; readonly token?: string; readonly userId?: string },
): Promise<void> {
  const db = input.database?.db;
  if (db === undefined) return;
  if (typeof session.id !== 'string' || session.id.length === 0
      || typeof session.token !== 'string' || session.token.length === 0) {
    return;
  }
  // Local consts so the transaction closure keeps the narrowed types.
  const authSessionId: string = session.id;
  const authSessionToken: string = session.token;
  const authUserId: string = session.userId ?? '';
  await db.transaction().execute(async (transaction) => {
    const mapping = await transaction.selectFrom('auth_user_account_map')
      .select(['account_id'])
      .where('auth_user_id', '=', authUserId)
      .executeTakeFirst();
    if (!mapping) return;
    const account = await transaction.selectFrom('accounts')
      .select(['security_epoch'])
      .where('id', '=', mapping.account_id)
      .executeTakeFirst();
    if (!account) return;
    const now = new Date();
    const inserted = await transaction.insertInto('known_auth_session_metadata')
      .values({
        auth_session_id: authSessionId,
        session_token_hash: browserSessionTokenHash(authSessionToken),
        account_id: mapping.account_id,
        idle_expires_at: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
        absolute_expires_at: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
        security_epoch: account.security_epoch,
        csrf_token_hash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(authSessionToken)),
        predecessor_session_id: null,
        last_seen_at: now,
        revoked_at: null,
        created_at: now,
      })
      .onConflict((conflict) => conflict.column('auth_session_id').doNothing())
      .returning('auth_session_id')
      .executeTakeFirst();
    // Rotation / test harnesses may already have minted this row. A no-op
    // insert must not kick another live session (P-07).
    if (!inserted) return;
    await evictOldestLiveBrowserSessions(transaction, {
      accountId: mapping.account_id,
      keepAuthSessionId: authSessionId,
      now,
      cap: BROWSER_SESSION_LIVE_CAP,
    });
  });
}

/** Guarded metadata establishment: redacted warning only, never a thrown auth failure. */
async function guardedEstablishSessionMetadata(
  input: BetterAuthRuntimeHooksContext,
  session: { readonly id?: string; readonly token?: string; readonly userId?: string },
): Promise<void> {
  try {
    await establishSessionMetadata(input, session);
  } catch (error) {
    // Redacted: classification only — never session/email material. The row
    // is retried on the next session creation (self-healing, like A2).
    input.logger?.warn(
      {
        classification: 'session_metadata_establishment_failed',
        ...(error instanceof Error ? { name: error.name } : {}),
      },
      'session metadata establishment failed; it will be retried on the next session creation',
    );
  }
}
