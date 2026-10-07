/**
 * Task A3: Better Auth 1.7.1 browser session authority over PostgreSQL.
 *
 * Binds the application BrowserSessionAuthority (modules/auth) to the real
 * Better Auth server API and the product database:
 *
 * - `createBetterAuthServerApi(auth)` wraps the REAL `auth.api` (the A1
 *   runtime seam: `betterAuth(buildBetterAuthOptions(...))`); product tests
 *   never mock `getSession`, they construct the real instance (plan A3
 *   假阳性防护);
 * - the metadata store implements `known_auth_session_metadata` CRUD plus the
 *   predecessor CAS (partial unique index) and the successor mint: rotation
 *   writes a new `auth_sessions` row whose shape mirrors BA 1.7.1
 *   `internalAdapter.createSession` (generateId-style id/token) and returns a
 *   cookie signed with the SAME scheme BA uses (`<token>.<base64 HMAC-SHA256
 *   over the token with the BA secret>`, better-call `signCookieValue`), so
 *   the browser cookie is accepted by BA's own `getSignedCookie` afterwards;
 * - CAS-loser convergence decrypts the winner's protected BA token through
 *   the same keyring used by the Better Auth adapter, then rebuilds the
 *   winner's signed cookie without exposing protected storage bytes.
 *
 * BA adapter transactions run outside product transactions (the authority
 * calls `betterAuth.getSession` before/independent of its unit of work), so
 * the Better Auth Kysely adapter never joins a product transaction.
 */
import { randomBytes, createHmac } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import { isPostgresErrorCode, DatabaseOperationError } from '../database/errors.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionIsolationLevel,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import {
  createPostgresAccountRepository,
  createPostgresIdentityClock,
  createPostgresSessionRepository,
} from '../identity/repositories.js';
import {
  createBrowserSessionAuthority,
  RotationCasConflictError,
  BROWSER_SESSION_LIVE_CAP,
  resolveBrowserSessionInventoryLimit,
  type BrowserSessionAuthority,
  type BrowserSessionAuthorityPorts,
  type BrowserSessionMetadataRow,
  type BrowserSessionMetadataStore,
  type BrowserSessionRequest,
  type BrowserSessionUnitOfWork,
  type BetterAuthServerPort,
  type BetterAuthSessionRecord,
  type MintedSuccessorSession,
} from '../../modules/auth/index.js';
import { createPostgresBusinessAccountMappingRepository } from './business-account-repositories.js';
import type { BetterAuthSessionTokenProtector } from './better-auth-session-token-protection.js';

const SESSION_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SESSION_TOKEN_LENGTH = 32;
const SESSION_TOKEN_ACCEPTANCE_LIMIT = 256 - (256 % SESSION_TOKEN_ALPHABET.length);

/**
 * P5: drop Better Auth 1.7.1 2FA trust-device verification rows for one
 * auth user. The two-factor plugin stores trust as:
 *   - signed cookie `known.trust_device` = `${hmac}!${trust-device-<random>}`
 *   - `auth_verifications` row: identifier = sha256(`trust-device-...`)
 *     (`verification.storeIdentifier: 'hashed'`), value = auth user id
 * Prefix-matching the identifier is impossible after hashing, so this deletes
 * by `value`. Pending 2FA challenge rows that also store the user id as value
 * die on the same security event (intended). Does not touch `auth_two_factor`
 * or `twoFactorEnabled`.
 */
export async function deleteTrustDeviceVerificationsForAuthUser(
  db: Kysely<DatabaseSchema>,
  authUserId: string,
): Promise<number> {
  const result = await db.deleteFrom('auth_verifications')
    .where('value', '=', authUserId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/**
 * [a-zA-Z0-9]{32} — mirrors Better Auth `generateId(32)` (session token/id).
 *
 * 256 is not divisible by 62, so reducing every byte modulo 62 would make
 * the first eight characters more likely. Rejecting the incomplete tail
 * keeps every accepted alphabet index backed by exactly four byte values.
 */
export function generateBetterAuthSessionToken(
  randomBytesSource: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  let out = '';
  while (out.length < SESSION_TOKEN_LENGTH) {
    const bytes = randomBytesSource(SESSION_TOKEN_LENGTH - out.length);
    if (bytes.length === 0) {
      throw new Error('Better Auth session token random source returned no bytes');
    }
    for (const byte of bytes) {
      if (byte >= SESSION_TOKEN_ACCEPTANCE_LIMIT) continue;
      out += SESSION_TOKEN_ALPHABET[byte % SESSION_TOKEN_ALPHABET.length]!;
      if (out.length === SESSION_TOKEN_LENGTH) break;
    }
  }
  return out;
}

/**
 * Build the signed BA cookie value exactly like better-call `signCookieValue`:
 * `<token>.<base64(HMAC-SHA256(secret, token))>`. The transport layer applies
 * the same percent-encoding as BA (`buildSessionSetCookie`), and BA's own
 * `getSignedCookie` verifies this signature on the next request.
 */
export function signBetterAuthSessionCookieValue(secret: string, token: string): string {
  const signature = createHmac('sha256', secret).update(token, 'utf8').digest('base64');
  return `${token}.${signature}`;
}

/** Wraps the REAL Better Auth 1.7.1 `auth.api` (never mocked in product tests). */
export function createBetterAuthServerApi(auth: ReturnType<typeof betterAuth>): BetterAuthServerPort {
  return {
    async getSession(request: BrowserSessionRequest): Promise<BetterAuthSessionRecord | null> {
      const headers = new Headers();
      if (request.cookie !== undefined) headers.set('cookie', request.cookie);
      // asResponse:false pins the better-call return shape (body + response
      // headers); the refreshed Set-Cookie for the SAME token is ignored — the
      // signature covers only the token, so the browser cookie stays valid.
      const result = await auth.api.getSession({ headers, asResponse: false, returnHeaders: true });
      const payload = result?.response;
      const session = payload?.session;
      if (!session) return null;
      const emailVerified = payload.user?.emailVerified === true;
      return {
        id: session.id,
        userId: session.userId,
        token: session.token,
        expiresAt: session.expiresAt,
        emailVerified,
      };
    },
    async signOut(request: BrowserSessionRequest): Promise<void> {
      const headers = new Headers();
      if (request.cookie !== undefined) headers.set('cookie', request.cookie);
      await auth.api.signOut({ headers });
    },
  };
}

function mapMetadataRow(row: {
  auth_session_id: string;
  session_token_hash: string;
  account_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  security_epoch: bigint | string;
  csrf_token_hash: string;
  predecessor_session_id: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}): BrowserSessionMetadataRow {
  return {
    authSessionId: row.auth_session_id,
    sessionTokenHash: row.session_token_hash,
    accountId: row.account_id,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    securityEpoch: BigInt(row.security_epoch),
    csrfTokenHash: row.csrf_token_hash,
    predecessorSessionId: row.predecessor_session_id,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export interface PostgresBrowserSessionStoreOptions {
  /** BA secret — signs successor cookies with BA's own scheme. */
  readonly secret: string;
  /** BA carrier TTL (config.sessionExpiresInSeconds, default idle 24h — G1 §7 P1). */
  readonly sessionExpiresInSeconds: number;
  /** Transparent at-rest codec shared with the Better Auth Kysely adapter. */
  readonly sessionTokenProtector: BetterAuthSessionTokenProtector;
}

/**
 * P-07: revoke + delete the oldest live BA sessions until the account is at
 * `cap`, never touching `keepAuthSessionId` and never bumping security_epoch.
 */
export async function evictOldestLiveBrowserSessions(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string;
    readonly keepAuthSessionId: string;
    readonly now: Date;
    readonly cap: number;
  },
): Promise<number> {
  const counted = await transaction
    .selectFrom('known_auth_session_metadata')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('account_id', '=', input.accountId)
    .where('revoked_at', 'is', null)
    .where('auth_session_id', 'in', transaction.selectFrom('auth_sessions').select('id'))
    .executeTakeFirst();
  const overflow = Number(counted?.n ?? 0) - input.cap;
  if (overflow <= 0) return 0;

  const victims = await transaction
    .selectFrom('known_auth_session_metadata')
    .select('auth_session_id')
    .where('account_id', '=', input.accountId)
    .where('revoked_at', 'is', null)
    .where('auth_session_id', '!=', input.keepAuthSessionId)
    .where('auth_session_id', 'in', transaction.selectFrom('auth_sessions').select('id'))
    .orderBy('last_seen_at', 'asc')
    .orderBy('auth_session_id', 'asc')
    .limit(overflow)
    .execute();

  let evicted = 0;
  for (const victim of victims) {
    const revoked = await transaction.updateTable('known_auth_session_metadata')
      .set({ revoked_at: input.now })
      .where('auth_session_id', '=', victim.auth_session_id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    await transaction.deleteFrom('auth_sessions')
      .where('id', '=', victim.auth_session_id)
      .executeTakeFirst();
    if (Number(revoked.numUpdatedRows) === 1) evicted += 1;
  }
  return evicted;
}

/** Transaction-bound metadata store over `known_auth_session_metadata` + `auth_sessions`. */
export function createPostgresBrowserSessionMetadataStore(
  transaction: DatabaseTransaction,
  options: PostgresBrowserSessionStoreOptions,
): BrowserSessionMetadataStore {
  return {
    async findByTokenHash(tokenHash) {
      const row = await transaction.selectFrom('known_auth_session_metadata').selectAll()
        .where('session_token_hash', '=', tokenHash)
        .executeTakeFirst();
      return row ? mapMetadataRow(row) : null;
    },
    async insert(row) {
      try {
        await transaction.insertInto('known_auth_session_metadata').values({
          auth_session_id: row.authSessionId,
          session_token_hash: row.sessionTokenHash,
          account_id: row.accountId,
          idle_expires_at: row.idleExpiresAt,
          absolute_expires_at: row.absoluteExpiresAt,
          security_epoch: row.securityEpoch,
          csrf_token_hash: row.csrfTokenHash,
          predecessor_session_id: row.predecessorSessionId,
          last_seen_at: row.lastSeenAt,
          revoked_at: row.revokedAt,
          created_at: row.createdAt,
        }).execute();
      } catch (error) {
        if (isPostgresErrorCode(error, '23505')) {
          throw new RotationCasConflictError();
        }
        throw error;
      }
      if (row.predecessorSessionId === null) {
        await evictOldestLiveBrowserSessions(transaction, {
          accountId: row.accountId,
          keepAuthSessionId: row.authSessionId,
          now: row.lastSeenAt,
          cap: BROWSER_SESSION_LIVE_CAP,
        });
      }
    },
    async markRevoked(authSessionId, revokedAt) {
      const result = await transaction.updateTable('known_auth_session_metadata')
        .set({ revoked_at: revokedAt })
        .where('auth_session_id', '=', authSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async touch(authSessionId, lastSeenAt, idleExpiresAt) {
      const result = await transaction.updateTable('known_auth_session_metadata')
        .set({ last_seen_at: lastSeenAt, idle_expires_at: idleExpiresAt })
        .where('auth_session_id', '=', authSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async findByPredecessor(predecessorSessionId) {
      const row = await transaction.selectFrom('known_auth_session_metadata').selectAll()
        .where('predecessor_session_id', '=', predecessorSessionId)
        .executeTakeFirst();
      return row ? mapMetadataRow(row) : null;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      const result = await transaction.updateTable('known_auth_session_metadata')
        .set({ revoked_at: revokedAt })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
    async mintSuccessorSession({ userId, now }): Promise<MintedSuccessorSession> {
      const id = generateBetterAuthSessionToken();
      const token = generateBetterAuthSessionToken();
      const protectedToken = options.sessionTokenProtector.protect(token);
      const expiresAt = new Date(now.getTime() + options.sessionExpiresInSeconds * 1000);
      await transaction.insertInto('auth_sessions').values({
        id,
        token: protectedToken.ciphertext,
        tokenLookupHash: protectedToken.lookupHash,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        ipAddress: '',
        userAgent: '',
        userId,
      }).execute();
      return {
        session: { id, userId, token, expiresAt },
        rawCookieValue: signBetterAuthSessionCookieValue(options.secret, token),
      };
    },
    async findSuccessorCookie(predecessorSessionId): Promise<MintedSuccessorSession | null> {
      const metadata = await this.findByPredecessor(predecessorSessionId);
      if (!metadata) return null;
      const row = await transaction.selectFrom('auth_sessions').selectAll()
        .where('id', '=', metadata.authSessionId)
        .executeTakeFirst();
      if (!row) return null;
      const token = options.sessionTokenProtector.reveal(row.token);
      return {
        session: { id: row.id, userId: row.userId, token, expiresAt: row.expiresAt },
        rawCookieValue: signBetterAuthSessionCookieValue(options.secret, token),
      };
    },
    async deleteAuthSessionsForAccount(accountId) {
      const result = await transaction.deleteFrom('auth_sessions')
        .where('userId', 'in',
          transaction.selectFrom('auth_user_account_map').select('auth_user_id')
            .where('account_id', '=', accountId))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async revokeOthersForAccount(accountId, keepAuthSessionId, revokedAt) {
      const result = await transaction.updateTable('known_auth_session_metadata')
        .set({ revoked_at: revokedAt })
        .where('account_id', '=', accountId)
        .where('auth_session_id', '!=', keepAuthSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
    async alignMetadataEpoch(authSessionId, securityEpoch) {
      const result = await transaction.updateTable('known_auth_session_metadata')
        .set({ security_epoch: securityEpoch })
        .where('auth_session_id', '=', authSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
    async deleteAuthSessionsForAccountExcept(accountId, keepAuthSessionId) {
      const result = await transaction.deleteFrom('auth_sessions')
        .where('userId', 'in',
          transaction.selectFrom('auth_user_account_map').select('auth_user_id')
            .where('account_id', '=', accountId))
        .where('id', '!=', keepAuthSessionId)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async listLiveForAccount(accountId, options) {
      const rows = await transaction.selectFrom('known_auth_session_metadata').selectAll()
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .where('auth_session_id', 'in',
          transaction.selectFrom('auth_sessions').select('id'))
        .orderBy('last_seen_at', 'desc')
        .orderBy('auth_session_id', 'desc')
        .limit(resolveBrowserSessionInventoryLimit(options))
        .execute();
      return rows.map(mapMetadataRow);
    },
    async evictOldestLiveForAccount(input) {
      return evictOldestLiveBrowserSessions(transaction, input);
    },
    async findLiveByAuthSessionId(authSessionId) {
      const row = await transaction.selectFrom('known_auth_session_metadata').selectAll()
        .where('auth_session_id', '=', authSessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!row) return null;
      const carrier = await transaction.selectFrom('auth_sessions').select('id')
        .where('id', '=', authSessionId)
        .executeTakeFirst();
      return carrier ? mapMetadataRow(row) : null;
    },
    async deleteAuthSessionById(authSessionId) {
      const result = await transaction.deleteFrom('auth_sessions')
        .where('id', '=', authSessionId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    },
    async deleteTrustDeviceStateForAccount(accountId) {
      const result = await transaction.deleteFrom('auth_verifications')
        .where('value', 'in',
          transaction.selectFrom('auth_user_account_map').select('auth_user_id')
            .where('account_id', '=', accountId))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

/** Builds the full transaction-bound authority ports for one database transaction. */
export function createPostgresBrowserSessionPorts(
  transaction: DatabaseTransaction,
  options: PostgresBrowserSessionStoreOptions,
): BrowserSessionAuthorityPorts {
  return {
    store: createPostgresBrowserSessionMetadataStore(transaction, options),
    mappings: createPostgresBusinessAccountMappingRepository(transaction),
    accounts: createPostgresAccountRepository(transaction),
    sessions: createPostgresSessionRepository(transaction),
    clock: createPostgresIdentityClock(transaction),
  };
}

export interface PostgresBrowserSessionUnitOfWorkOptions extends PostgresBrowserSessionStoreOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly retry?: {
    /** Total attempts including the first (default 3). */
    readonly maxAttempts: number;
    /** Base delay between retries in ms; doubles per attempt (default 10). */
    readonly baseDelayMs: number;
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 10;

/**
 * Module-owned unit of work for authority flows. One REAL database transaction
 * per execute(); transient failures (serialization/deadlock/lock-timeout) are
 * retried in a fresh transaction. Rotation CAS conflicts are NOT retried — the
 * application facade resolves the winner instead.
 */
export function createPostgresBrowserSessionUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresBrowserSessionUnitOfWorkOptions,
): BrowserSessionUnitOfWork {
  const maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('retry.maxAttempts must be a positive integer');
  }
  const baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel,
    faultInjector: options.faultInjector,
  });

  return {
    async execute<Result>(work: (ports: BrowserSessionAuthorityPorts) => Promise<Result>): Promise<Result> {
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await unitOfWork.execute(({ transaction }) =>
            work(createPostgresBrowserSessionPorts(transaction, options)));
        } catch (error) {
          if (!isRetryableDatabaseError(error) || attempt + 1 >= maxAttempts) throw error;
          lastError = error;
          await sleep(baseDelayMs * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

export interface BetterAuthSessionAuthorityOptions extends PostgresBrowserSessionUnitOfWorkOptions {
  readonly db: Kysely<DatabaseSchema>;
  /** The REAL Better Auth server API seam (A1 runtime: betterAuth(buildBetterAuthOptions(...))). */
  readonly betterAuth: BetterAuthServerPort;
  /** Override TTLs for tests (defaults come from session-policy.ts via the application layer). */
  readonly idleTtlMs?: number;
  readonly absoluteTtlMs?: number;
  readonly rotationMinAgeMs?: number;
  readonly touchMinIntervalMs?: number;
}

/** Construct the production authority: real BA server API + real PostgreSQL. */
export function createBetterAuthSessionAuthority(
  options: BetterAuthSessionAuthorityOptions,
): BrowserSessionAuthority {
  const { db, betterAuth, ...storeOptions } = options;
  const unitOfWork = createPostgresBrowserSessionUnitOfWork(db, storeOptions);
  return createBrowserSessionAuthority({
    unitOfWork,
    betterAuth,
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    ...(options.absoluteTtlMs === undefined ? {} : { absoluteTtlMs: options.absoluteTtlMs }),
    ...(options.rotationMinAgeMs === undefined ? {} : { rotationMinAgeMs: options.rotationMinAgeMs }),
    ...(options.touchMinIntervalMs === undefined ? {} : { touchMinIntervalMs: options.touchMinIntervalMs }),
  });
}

function isRetryableDatabaseError(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.retryableAtCommandBoundary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
