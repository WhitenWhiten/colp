/**
 * Product-session gate for Better Auth browser endpoints (A1).
 *
 * Better Auth's own session carrier can outlive the product session row
 * (`known_auth_session_metadata`): rotation, idle/absolute expiry, an explicit
 * product revoke, or an account disable/epoch bump all leave the BA session
 * valid for BA. Every mounted BA endpoint that mutates identity or mints an
 * authorization artifact must therefore consult the product authority before
 * Better Auth performs the mutation. Public endpoints (sign-in, OTP send,
 * verification links) and read-only endpoints (`/get-session`) never gate.
 */
import { APIError, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { BetterAuthRuntimeInput } from './better-auth-runtime-contract.js';

type ProductSessionContext = Parameters<typeof getAuthoritativeSessionFromCtx>[0];
/** The BA session carrier shape the product metadata check consumes. */
export type ProductSessionCarrier = ProductSessionContext['context']['session'];

/**
 * BA endpoints that authenticate a browser session and then mutate identity
 * or mint an authorization artifact. Keep this list explicit and aligned with
 * `BETTER_AUTH_ALLOWLIST`: adding a mounted identity-mutating endpoint without
 * gating it fails the unit test.
 *
 * `/oauth2/consent` mints the MCP authorization code (the consent POST) and
 * `/change-password` mutates the credential, so both need the live product
 * session even though Better Auth itself accepts the BA carrier. `/sign-out`
 * and `/revoke-session` stay ungated: they end sessions and never mint.
 */
export const PRODUCT_SESSION_AUTHENTICATED_PATHS: ReadonlySet<string> = new Set([
  '/oauth2/authorize',
  '/oauth2/consent',
  '/change-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
]);

/**
 * Whether the product-session gate must run before Better Auth handles the
 * request.
 *
 * `/oauth2/authorize` is the browser entry point: when the request carries no
 * live Better Auth session (absent cookie, expired session, or rotated-away
 * cookie), Better Auth must handle it so it can redirect the browser to the
 * login page. Enforcing the product check there would replace that redirect
 * with a JSON 401. Every other gated endpoint fails closed without a session.
 */
export function requiresProductSessionCheck(
  path: string | undefined,
  liveAuthSessionId: string | null,
): boolean {
  if (path === undefined || !PRODUCT_SESSION_AUTHENTICATED_PATHS.has(path)) return false;
  return !(path === '/oauth2/authorize' && liveAuthSessionId === null);
}

/**
 * Resolve the Better Auth session the product gate must verify.
 *
 * Prefer a session already established on the endpoint context: OAuth
 * Provider 1.7.1 resumes a paused authorize by re-dispatching
 * `/oauth2/authorize` with the freshly signed-in session in
 * `ctx.context.session` before its cookie is presented. The authoritative
 * reader nulls the context session first, so re-reading the cookie here would
 * destroy that session, skip the gate for the live session, and make Better
 * Auth bounce the authenticated browser back to `/login` instead of consent.
 */
export async function resolveProductSessionCarrier(
  ctx: ProductSessionContext,
): Promise<ProductSessionCarrier> {
  if (ctx.context.session != null) return ctx.context.session;
  return getAuthoritativeSessionFromCtx(ctx);
}

/** The live BA session id carried by `resolveProductSessionCarrier`. */
export function liveAuthSessionIdOf(carrier: ProductSessionCarrier): string | null {
  const candidate = carrier?.session.id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export async function assertProductSessionActive(
  session: ProductSessionCarrier,
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  // A live Better Auth carrier still needs product lifetime checks with database time.
  const candidate = session?.session.id;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw APIError.from('UNAUTHORIZED', {
      code: 'session_context_unavailable',
      message: 'The browser session could not be verified.',
    });
  }
  const row = await db.selectFrom('known_auth_session_metadata')
    .select(['revoked_at', 'security_epoch', 'account_id'])
    .where('auth_session_id', '=', candidate)
    .where('idle_expires_at', '>', sql<Date>`clock_timestamp()`)
    .where('absolute_expires_at', '>', sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  if (!row || row.revoked_at !== null) {
    throw APIError.from('UNAUTHORIZED', {
      code: 'session_revoked', message: 'The browser session is no longer valid.',
    });
  }
  const account = await db.selectFrom('accounts').select(['security_epoch', 'status', 'deleted_at'])
    .where('id', '=', row.account_id).executeTakeFirst();
  if (!account || account.status !== 'active' || account.deleted_at !== null
      || BigInt(account.security_epoch) !== BigInt(row.security_epoch)) {
    throw APIError.from('UNAUTHORIZED', {
      code: 'session_revoked', message: 'The browser session is no longer valid.',
    });
  }
}

/**
 * Email-change post-response seam (guard: `ctx.context.newSession` is set only
 * after the endpoint committed the mailbox change; Better Auth re-issues the
 * SAME session through `setSessionCookie`).
 *
 * The P9 establishment transaction inside `afterEmailVerification` already
 * raised the account epoch and revoked OAuth refresh families. The requesting
 * session keeps its Better Auth carrier, so `onEmailChanged` must revoke the
 * account's OTHER browser sessions and realign this session's metadata to the
 * committed epoch. Guarded: the email is already changed, so a revoke failure
 * must not fail the response (the epoch bump still invalidates every stale
 * metadata row — fail closed).
 */
export async function completeEmailChangeSessionRevocation(input: {
  readonly newSession: {
    readonly user?: { readonly id?: string | null } | null;
    readonly session?: { readonly id?: string | null } | null;
  } | null | undefined;
  readonly onEmailChanged?: BetterAuthRuntimeInput<never>['onEmailChanged'];
  readonly logger?: BetterAuthRuntimeInput<never>['logger'];
}): Promise<void> {
  const onEmailChanged = input.onEmailChanged;
  if (onEmailChanged === undefined) return;
  const authUserId = input.newSession?.user?.id;
  const currentAuthSessionId = input.newSession?.session?.id;
  if (typeof authUserId !== 'string' || authUserId.length === 0
      || typeof currentAuthSessionId !== 'string' || currentAuthSessionId.length === 0) {
    return;
  }
  try {
    await onEmailChanged({ authUserId, currentAuthSessionId });
  } catch (error) {
    input.logger?.warn(
      {
        classification: 'email_change_session_revoke_failed',
        ...(error instanceof Error ? { name: error.name } : {}),
      },
      'email-change session revoke failed; the email is already changed',
    );
  }
}
