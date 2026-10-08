/**
 * Task E1: Better Auth test session factory (plan §11 Task E1).
 *
 * Replaces the legacy OIDC `issueTestSession` seam. Sessions are minted as
 * REAL Better Auth 1.7.1 sessions (auth_sessions row + signed)
 * `__Host-known_session` cookie + known_auth_session_metadata +
 * auth_user_account_map + business account/profile/handle) and authenticated
 * through the REAL A3 `BrowserSessionAuthority` facade:
 *
 * - in-memory backend (unit tests): `createBrowserSessionAuthority` over the
 *   harness memory identity ports + an in-memory BA session store. The cookie
 *   is signed with BA's own scheme (`signBetterAuthSessionCookieValue`) and
 *   validated by the REAL parsers (`parseBrowserSessionCookie`,
 *   `browserSessionTokenOf`) and the REAL CSRF derivation
 *   (`deriveBrowserSessionCsrfTokenRaw`) — the same code the production
 *   authority runs (假阴性防护: factory cookies always pass the real parser);
 * - PostgreSQL backend (integration): a REAL `betterAuth` instance over the
 *   test database (A3 seed pattern); the REAL `auth.api.getSession` validates
 *   every cookie against the real `auth_sessions` rows, and the authority is
 *   `createBetterAuthSessionAuthority`.
 *
 * 假阳性防护:
 * - no legacy `sessions` row is ever written (the factory mints BA carrier
 *   rows only); the product inserts only `knst1` ciphertext + keyed lookup,
 *   while the real Better Auth adapter still observes its plaintext contract;
 * - `known_test.*` codes and `VITE_MOCK_SESSION` are never used as evidence;
 * - the returned cookie is a full Cookie header built by the real
 *   `browserSessionCookieHeader` (percent-encoded signed value).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import { createBetterAuthServerApi, createBetterAuthSessionAuthority, signBetterAuthSessionCookieValue } from '../../src/infrastructure/auth/better-auth-session-authority.js';
import { buildBetterAuthOptions, type BetterAuthRuntimeConfig } from '../../src/infrastructure/auth/better-auth-runtime.js';
import { TEST_SESSION_TOKEN_PROTECTION, createTestSessionTokenProtector } from './better-auth-session-token-protection.js';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import {
  BROWSER_SESSION_COOKIE_NAME,
  BROWSER_SESSION_LIVE_CAP,
  browserSessionCookieHeader,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  browserSessionTokenOf,
  createBrowserSessionAuthority,
  deriveBrowserSessionCsrfTokenRaw,
  parseBrowserSessionCookie,
  rankLiveSessionsForInventory,
  resolveBrowserSessionInventoryLimit,
  RotationCasConflictError,
  selectOldestLiveSessionsToEvict,
  type BetterAuthServerPort,
  type BetterAuthSessionRecord,
  type BrowserSessionAuthority,
  type BrowserSessionAuthorityPorts,
  type BrowserSessionMetadataRow,
  type BrowserSessionMetadataStore,
  type BrowserSessionRequest,
  type BrowserSessionUnitOfWork,
  type MintedSuccessorSession,
} from '../../src/modules/auth/index.js';
import {
  generateOpaqueId,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_ROTATION_MIN_AGE_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
  type Account,
  type AuthUserAccountMapping,
  type IdentityUnitOfWork,
  type Profile,
  type ProfileHandle,
} from '../../src/modules/identity/index.js';

/** Default test BA secret (test-only; never a production credential). */
export const BETTER_AUTH_TEST_SECRET = 'e1-better-auth-test-secret-0123456789abcdef';
export const BETTER_AUTH_TEST_SESSION_TTL_SECONDS = 86_400;

/** Stable client shape returned by the factory (issueTestSession contract). */
export interface AuthenticatedTestClient {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

export interface IssueTestSessionInput {
  /**
   * Stable test identity key (replaces the legacy OIDC subject). The FIRST
   * issue for a key creates the business account; later issues reuse it and
   * mint a fresh session (mirror of the legacy (issuer, subject) reuse).
   */
  readonly subject: string;
  readonly handle: string;
  readonly displayName?: string;
  /** Pin the business account id (legacy `accountId` passthrough). */
  readonly accountId?: string;
  /** When false, the BA session is occupancy (P1), not a product actor. Default true. */
  readonly emailVerified?: boolean;
}

export interface BetterAuthTestFactory {
  readonly authority: BrowserSessionAuthority;
  readonly secret: string;
  readonly sessionExpiresInSeconds: number;
  issueTestSession(input: IssueTestSessionInput): Promise<AuthenticatedTestClient>;
}

export interface IssueTestSessionCall extends IssueTestSessionInput {
  readonly factory: BetterAuthTestFactory;
}

/**
 * Free-function seam kept for the migrated call sites: delegates to the
 * factory so callers keep receiving the compatible
 * `{cookie, csrfToken, accountId, subjectId}` shape (plan §11 E1 step 1).
 */
export async function issueTestSession(input: IssueTestSessionCall): Promise<AuthenticatedTestClient> {
  return input.factory.issueTestSession(input);
}

// ---------------------------------------------------------------------------
// Shared minting material (both backends)
// ---------------------------------------------------------------------------

/** Mirrors Better Auth `generateId(32)` ([a-zA-Z0-9]{32} session token/id). */
function generateBaToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(32);
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    out += alphabet[bytes[index]! % alphabet.length];
  }
  return out;
}

function signCookie(secret: string, token: string): string {
  return signBetterAuthSessionCookieValue(secret, token);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify the cookie exactly like BA's `getSignedCookie` (split at last dot, HMAC-SHA256). */
function verifySignedCookie(secret: string, cookieValue: string, token: string): boolean {
  const dot = cookieValue.lastIndexOf('.');
  if (dot < 1) return false;
  return constantTimeEqual(signCookie(secret, token), cookieValue);
}

export interface MintedTestSessionMaterial {
  readonly sessionId: string;
  readonly token: string;
  readonly rawCookieValue: string;
  readonly rawCsrfToken: string;
  readonly metadata: BrowserSessionMetadataRow;
}

function mintTestSessionMaterial(input: {
  readonly secret: string;
  readonly sessionExpiresInSeconds: number;
  readonly now: Date;
  readonly accountId: string;
  readonly securityEpoch: bigint;
}): MintedTestSessionMaterial {
  const sessionId = generateBaToken();
  const token = generateBaToken();
  const rawCookieValue = signCookie(input.secret, token);
  const rawCsrfToken = deriveBrowserSessionCsrfTokenRaw(token);
  const metadata: BrowserSessionMetadataRow = {
    authSessionId: sessionId,
    sessionTokenHash: browserSessionTokenHash(token),
    accountId: input.accountId,
    idleExpiresAt: new Date(input.now.getTime() + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(input.now.getTime() + SESSION_ABSOLUTE_TTL_MS),
    securityEpoch: input.securityEpoch,
    csrfTokenHash: browserSessionCsrfTokenHash(rawCsrfToken),
    predecessorSessionId: null,
    lastSeenAt: input.now,
    revokedAt: null,
    createdAt: input.now,
  };
  return { sessionId, token, rawCookieValue, rawCsrfToken, metadata };
}

function toClient(material: MintedTestSessionMaterial, accountId: string, subjectId: string): AuthenticatedTestClient {
  return {
    cookie: browserSessionCookieHeader(material.rawCookieValue),
    csrfToken: material.rawCsrfToken,
    accountId,
    subjectId,
  };
}

// ---------------------------------------------------------------------------
// In-memory backend (unit tests)
// ---------------------------------------------------------------------------

interface InMemoryBaSessionRow {
  readonly id: string;
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface InMemoryBetterAuthTestFactoryState {
  readonly authUsers: ReadonlyMap<string, {
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
  }>;
  readonly sessions: ReadonlyMap<string, InMemoryBaSessionRow>;
  readonly metadata: ReadonlyMap<string, BrowserSessionMetadataRow>;
  readonly mappings: ReadonlyMap<string, AuthUserAccountMapping>;
}

export interface InMemoryBetterAuthTestFactory extends BetterAuthTestFactory {
  readonly state: InMemoryBetterAuthTestFactoryState;
  /** Introspection: number of live (non-revoked) sessions for an account. */
  liveSessionCountForAccount(accountId: string): number;
  /**
   * Test hook: rewrite the metadata `lastSeenAt` for the account's live
   * session (mirrors a legacy-session-state mutation; the authority then
   * proves the route did not overwrite it). Returns false when no live
   * metadata row exists for the account.
   */
  setMetadataLastSeenAt(accountId: string, lastSeenAt: Date): boolean;
}

export function createInMemoryBetterAuthTestFactory(options: {
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly secret?: string;
  readonly sessionExpiresInSeconds?: number;
}): InMemoryBetterAuthTestFactory {
  const secret = options.secret ?? BETTER_AUTH_TEST_SECRET;
  const sessionExpiresInSeconds = options.sessionExpiresInSeconds ?? BETTER_AUTH_TEST_SESSION_TTL_SECONDS;

  const authUsers = new Map<string, { readonly id: string; readonly email: string; readonly emailVerified: boolean }>();
  const sessions = new Map<string, InMemoryBaSessionRow>();
  const sessionsByToken = new Map<string, InMemoryBaSessionRow>();
  const metadata = new Map<string, BrowserSessionMetadataRow>();
  const metadataByAuthSessionId = new Map<string, BrowserSessionMetadataRow>();
  const mappings = new Map<string, AuthUserAccountMapping>();
  const mappingByAccountId = new Map<string, AuthUserAccountMapping>();
  const accountBySubject = new Map<string, string>();

  const store: BrowserSessionMetadataStore = {
    async findByTokenHash(tokenHash) {
      return metadata.get(tokenHash) ?? null;
    },
    async insert(row) {
      if (row.predecessorSessionId !== null) {
        for (const existing of metadata.values()) {
          if (existing.predecessorSessionId === row.predecessorSessionId) {
            throw new RotationCasConflictError();
          }
        }
      }
      metadata.set(row.sessionTokenHash, row);
      metadataByAuthSessionId.set(row.authSessionId, row);
      if (row.predecessorSessionId === null) {
        await store.evictOldestLiveForAccount({
          accountId: row.accountId,
          keepAuthSessionId: row.authSessionId,
          now: row.lastSeenAt,
          cap: BROWSER_SESSION_LIVE_CAP,
        });
      }
    },
    async markRevoked(authSessionId, revokedAt) {
      for (const [tokenHash, row] of metadata) {
        if (row.authSessionId === authSessionId && row.revokedAt === null) {
          metadata.set(tokenHash, { ...row, revokedAt });
          metadataByAuthSessionId.set(authSessionId, { ...row, revokedAt });
          return true;
        }
      }
      return false;
    },
    async touch(authSessionId, lastSeenAt, idleExpiresAt) {
      for (const [tokenHash, row] of metadata) {
        if (row.authSessionId === authSessionId && row.revokedAt === null) {
          const touched = { ...row, lastSeenAt, idleExpiresAt };
          metadata.set(tokenHash, touched);
          metadataByAuthSessionId.set(authSessionId, touched);
          return true;
        }
      }
      return false;
    },
    async findByPredecessor(predecessorSessionId) {
      for (const row of metadata.values()) {
        if (row.predecessorSessionId === predecessorSessionId) return row;
      }
      return null;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      let count = 0;
      for (const [tokenHash, row] of metadata) {
        if (row.accountId === accountId && row.revokedAt === null) {
          metadata.set(tokenHash, { ...row, revokedAt });
          metadataByAuthSessionId.set(row.authSessionId, { ...row, revokedAt });
          count += 1;
        }
      }
      return count;
    },
    async mintSuccessorSession({ userId, now }): Promise<MintedSuccessorSession> {
      const id = generateBaToken();
      const token = generateBaToken();
      const row: InMemoryBaSessionRow = {
        id,
        userId,
        token,
        expiresAt: new Date(now.getTime() + sessionExpiresInSeconds * 1000),
      };
      sessions.set(id, row);
      sessionsByToken.set(token, row);
      return { session: { id, userId, token, expiresAt: row.expiresAt }, rawCookieValue: signCookie(secret, token) };
    },
    async findSuccessorCookie(predecessorSessionId): Promise<MintedSuccessorSession | null> {
      let successor: BrowserSessionMetadataRow | null = null;
      for (const row of metadata.values()) {
        if (row.predecessorSessionId === predecessorSessionId) successor = row;
      }
      if (!successor) return null;
      const row = sessions.get(successor.authSessionId);
      if (!row) return null;
      return {
        session: { id: row.id, userId: row.userId, token: row.token, expiresAt: row.expiresAt },
        rawCookieValue: signCookie(secret, row.token),
      };
    },
    async deleteAuthSessionsForAccount(accountId) {
      // Mirror the real PG store: delete sessions of EVERY auth user mapped to
      // the account (a re-issued subject mints a fresh auth user per session).
      const authUserIds = new Set<string>();
      for (const mapping of mappings.values()) {
        if (mapping.accountId === accountId) authUserIds.add(mapping.authUserId);
      }
      let count = 0;
      for (const [id, row] of sessions) {
        if (authUserIds.has(row.userId)) {
          sessions.delete(id);
          sessionsByToken.delete(row.token);
          count += 1;
        }
      }
      return count;
    },
    async revokeOthersForAccount(accountId, keepAuthSessionId, revokedAt) {
      let count = 0;
      for (const [id, row] of metadata) {
        if (row.accountId !== accountId || id === keepAuthSessionId || row.revokedAt !== null) continue;
        metadata.set(id, { ...row, revokedAt });
        count += 1;
      }
      return count;
    },
    async alignMetadataEpoch(authSessionId, securityEpoch) {
      const row = metadata.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, securityEpoch };
      metadata.set(authSessionId, next);
      return true;
    },
    async deleteAuthSessionsForAccountExcept(accountId, keepAuthSessionId) {
      const authUserIds = new Set<string>();
      for (const mapping of mappings.values()) {
        if (mapping.accountId === accountId) authUserIds.add(mapping.authUserId);
      }
      let count = 0;
      for (const [id, row] of sessions) {
        if (!authUserIds.has(row.userId) || id === keepAuthSessionId) continue;
        sessions.delete(id);
        sessionsByToken.delete(row.token);
        count += 1;
      }
      return count;
    },
    async listLiveForAccount(accountId, options) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of metadataByAuthSessionId.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!sessions.has(row.authSessionId)) continue;
        live.push(row);
      }
      return rankLiveSessionsForInventory(live, resolveBrowserSessionInventoryLimit(options));
    },
    async evictOldestLiveForAccount({ accountId, keepAuthSessionId, now, cap }) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of metadataByAuthSessionId.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!sessions.has(row.authSessionId)) continue;
        live.push(row);
      }
      const victims = selectOldestLiveSessionsToEvict(live, { keepAuthSessionId, cap });
      for (const victim of victims) {
        await store.markRevoked(victim.authSessionId, now);
        await store.deleteAuthSessionById(victim.authSessionId);
      }
      return victims.length;
    },
    async findLiveByAuthSessionId(authSessionId) {
      const row = metadataByAuthSessionId.get(authSessionId);
      if (!row || row.revokedAt !== null) return null;
      if (!sessions.has(authSessionId)) return null;
      return row;
    },
    async deleteAuthSessionById(authSessionId) {
      const row = sessions.get(authSessionId);
      if (!row) return false;
      sessions.delete(authSessionId);
      sessionsByToken.delete(row.token);
      return true;
    },
    async deleteTrustDeviceStateForAccount() {
      return 0;
    },
  };

  const betterAuthServer: BetterAuthServerPort = {
    async getSession(request: BrowserSessionRequest): Promise<BetterAuthSessionRecord | null> {
      const parsed = parseBrowserSessionCookie(request.cookie);
      if (parsed.kind !== 'present') return null;
      const token = browserSessionTokenOf(parsed.value);
      if (token === null || !verifySignedCookie(secret, parsed.value, token)) return null;
      const row = sessionsByToken.get(token);
      if (!row) return null;
      const now = await options.identityUnitOfWork.execute((ports) => ports.clock.now());
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      const user = authUsers.get(row.userId);
      return {
        id: row.id,
        userId: row.userId,
        token,
        expiresAt: row.expiresAt,
        emailVerified: user?.emailVerified !== false,
      };
    },
    async signOut(request: BrowserSessionRequest): Promise<void> {
      const parsed = parseBrowserSessionCookie(request.cookie);
      if (parsed.kind !== 'present') return;
      const token = browserSessionTokenOf(parsed.value);
      if (token === null) return;
      const row = sessionsByToken.get(token);
      if (!row) return;
      sessions.delete(row.id);
      sessionsByToken.delete(token);
    },
  };

  const unitOfWork: BrowserSessionUnitOfWork = {
    async execute<Result>(work: (ports: BrowserSessionAuthorityPorts) => Promise<Result>): Promise<Result> {
      return options.identityUnitOfWork.execute((identityPorts) =>
        work({
          store,
          mappings: {
            async findByAuthUserId(authUserId) {
              return mappings.get(authUserId) ?? null;
            },
            async insert(mapping) {
              if (mappings.has(mapping.authUserId) || mappingByAccountId.has(mapping.accountId)) {
                throw new Error('duplicate mapping');
              }
              mappings.set(mapping.authUserId, mapping);
              mappingByAccountId.set(mapping.accountId, mapping);
            },
          },
          accounts: identityPorts.accounts,
          sessions: identityPorts.sessions,
          clock: identityPorts.clock,
          revokeOAuthRefreshTokensForAccount: async () => 0,
        }));
    },
  };

  const authority = createBrowserSessionAuthority({
    unitOfWork,
    betterAuth: betterAuthServer,
    rotationMinAgeMs: SESSION_ROTATION_MIN_AGE_MS,
    touchMinIntervalMs: SESSION_TOUCH_MIN_INTERVAL_MS,
  });

  async function issue(input: IssueTestSessionInput): Promise<AuthenticatedTestClient> {
    const now = await options.identityUnitOfWork.execute((ports) => ports.clock.now());
    const normalizedHandle = input.handle.toLowerCase();

    const account = await options.identityUnitOfWork.execute(async (ports): Promise<Account> => {
      const reusedId = input.accountId ?? accountBySubject.get(input.subject);
      if (reusedId !== undefined) {
        const existing = await ports.accounts.findById(reusedId);
        if (existing) return existing;
        if (input.accountId === undefined) accountBySubject.delete(input.subject);
      }
      const accountId = input.accountId ?? generateOpaqueId();
      const subjectId = generateOpaqueId();
      const fresh: Account = {
        id: accountId,
        subjectId,
        status: 'active',
        email: input.email ?? null,
        securityEpoch: 0n,
        createdAt: now,
        deletedAt: null,
      };
      await ports.accounts.insert(fresh);
      const profile: Profile = {
        accountId,
        displayName: input.displayName ?? input.subject,
        avatarUrl: null,
        about: '',
        updatedAt: now,
      };
      await ports.profiles.insert(profile);
      const handleRow: ProfileHandle = {
        handle: normalizedHandle,
        accountId,
        createdAt: now,
      };
      const existingHandle = await ports.handles.findByAccountId(accountId);
      if (!existingHandle) await ports.handles.insert(handleRow);
      if (input.accountId === undefined) accountBySubject.set(input.subject, accountId);
      return fresh;
    });

    // Auth user + 1:1 mapping (real schema contract: auth_users.email UNIQUE,
    // auth_user_account_map 1:1). A re-issued subject reuses the SAME auth
    // user (a BA user owns many sessions); the account never gains a second
    // auth user or mapping. Mirror of the PG factory below.
    const authUserEmail = input.email ?? `${input.subject}@example.test`;
    let authUserId = mappingByAccountId.get(account.id)?.authUserId;
    if (authUserId === undefined) {
      for (const user of authUsers.values()) {
        if (user.email === authUserEmail) {
          authUserId = user.id;
          break;
        }
      }
      if (authUserId === undefined) {
        authUserId = `auth-user-${generateOpaqueId()}`;
        authUsers.set(authUserId, {
          id: authUserId,
          email: authUserEmail,
          emailVerified: input.emailVerified !== false,
        });
      }
      const mapping: AuthUserAccountMapping = { authUserId, accountId: account.id, createdAt: now };
      mappings.set(authUserId, mapping);
      mappingByAccountId.set(account.id, mapping);
    }

    const material = mintTestSessionMaterial({
      secret,
      sessionExpiresInSeconds,
      now,
      accountId: account.id,
      securityEpoch: account.securityEpoch,
    });
    sessions.set(material.sessionId, {
      id: material.sessionId,
      userId: authUserId,
      token: material.token,
      expiresAt: new Date(now.getTime() + sessionExpiresInSeconds * 1000),
    });
    sessionsByToken.set(material.token, sessions.get(material.sessionId)!);
    await store.insert(material.metadata);

    return toClient(material, account.id, account.subjectId);
  }

  // Serialize concurrent issues: the in-process `accountBySubject` reuse map
  // is not atomic across awaits, so two concurrent `issueTestSession` calls
  // for the same subject would each mint their own account (mirror of the
  // concurrent-OIDC-login convergence contract).
  let issueTail: Promise<unknown> = Promise.resolve();
  function issueSerialized(input: IssueTestSessionInput): Promise<AuthenticatedTestClient> {
    const run = issueTail.then(() => issue(input));
    issueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    authority,
    secret,
    sessionExpiresInSeconds,
    issueTestSession: issueSerialized,
    state: {
      get authUsers() { return authUsers; },
      get sessions() { return sessions; },
      get metadata() { return metadata; },
      get mappings() { return mappings; },
    },
    liveSessionCountForAccount(accountId) {
      // Count sessions of EVERY auth user mapped to the account (re-issue
      // mints a fresh auth user per session, so the latest mapping alone
      // would undercount).
      const authUserIds = new Set<string>();
      for (const mapping of mappings.values()) {
        if (mapping.accountId === accountId) authUserIds.add(mapping.authUserId);
      }
      let count = 0;
      for (const row of sessions.values()) {
        if (authUserIds.has(row.userId)) count += 1;
      }
      return count;
    },
    setMetadataLastSeenAt(accountId, lastSeenAt) {
      for (const [tokenHash, row] of metadata) {
        if (row.accountId === accountId && row.revokedAt === null) {
          const updated = { ...row, lastSeenAt };
          metadata.set(tokenHash, updated);
          metadataByAuthSessionId.set(row.authSessionId, updated);
          return true;
        }
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL backend (integration tests)
// ---------------------------------------------------------------------------

export interface PostgresBetterAuthTestFactoryOptions {
  readonly db: Kysely<DatabaseSchema>;
  readonly secret?: string;
  readonly sessionExpiresInSeconds?: number;
  readonly baseURL?: string;
  readonly basePath?: string;
  /** Clock override for minted rows (default: real time). */
  readonly now?: () => Date;
}

export interface PostgresBetterAuthTestFactory extends BetterAuthTestFactory {
  /** The REAL Better Auth instance backing the authority (never mocked). */
  readonly auth: ReturnType<typeof betterAuth>;
}

function baRuntimeConfig(options: {
  readonly secret: string;
  readonly sessionExpiresInSeconds: number;
  readonly baseURL: string;
  readonly basePath: string;
}): BetterAuthRuntimeConfig {
  return {
    baseURL: options.baseURL,
    basePath: options.basePath,
    secret: options.secret,
    sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
    trustedOrigins: [options.baseURL],
    cookieName: BROWSER_SESSION_COOKIE_NAME,
    sessionExpiresInSeconds: options.sessionExpiresInSeconds,
    sessionUpdateAgeSeconds: 60,
    bodyLimitBytes: 1024 * 1024,
    emailOtp: null,
    social: null,
    passwordHash: {
      hash: async (password: string) => `e1-test-dummy:${password}`,
      verify: async () => false,
    },
  };
}

/**
 * Real PostgreSQL factory: REAL betterAuth + REAL auth_sessions/metadata rows
 * (the A3 seed pattern; the REAL `auth.api.getSession` validates every
 * cookie). Business accounts are created with the A2 semantics: no
 * account_identities row, unverified email never stored.
 */
export function createPostgresBetterAuthTestFactory(
  options: PostgresBetterAuthTestFactoryOptions,
): PostgresBetterAuthTestFactory {
  const secret = options.secret ?? BETTER_AUTH_TEST_SECRET;
  const sessionExpiresInSeconds = options.sessionExpiresInSeconds ?? BETTER_AUTH_TEST_SESSION_TTL_SECONDS;
  const baseURL = options.baseURL ?? 'http://localhost';
  const basePath = options.basePath ?? '/api/v1/auth';
  const clock = options.now ?? (() => new Date());
  const sessionTokenProtector = createTestSessionTokenProtector();

  const auth = betterAuth(buildBetterAuthOptions({
    enabled: true,
    config: baRuntimeConfig({ secret, sessionExpiresInSeconds, baseURL, basePath }),
    database: { db: options.db, type: 'postgres', transaction: true },
  }));
  const authority = createBetterAuthSessionAuthority({
    db: options.db,
    betterAuth: createBetterAuthServerApi(auth),
    secret,
    sessionExpiresInSeconds,
    sessionTokenProtector,
  });

  const accountBySubject = new Map<string, string>();

  async function existingAccount(accountId: string): Promise<Account | null> {
    const row = await options.db.selectFrom('accounts').selectAll()
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      subjectId: row.subject_id,
      status: row.status,
      email: row.email,
      securityEpoch: BigInt(row.security_epoch),
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    };
  }

  async function issue(input: IssueTestSessionInput): Promise<AuthenticatedTestClient> {
    const now = clock();
    const normalizedHandle = input.handle.toLowerCase();
    const authUserEmail = input.email ?? `${input.subject}@example.test`;

    // 1:1 contract pre-resolution (auth_user_account_map.auth_user_id UNIQUE):
    // when a Better Auth user for this email is ALREADY mapped to a business
    // account, that account wins — a second factory issuing the same verified
    // email/subject must reuse the existing account instead of creating a
    // duplicate and remapping the same auth user (which the unique constraint
    // rejects). Mirrors the A2 ensureBusinessAccount contract.
    const existingMapped = input.accountId === undefined
      ? await options.db.selectFrom('auth_user_account_map as m')
          .innerJoin('auth_users as u', 'u.id', 'm.auth_user_id')
          .innerJoin('accounts as a', 'a.id', 'm.account_id')
          .select([
            'm.auth_user_id', 'm.account_id', 'a.subject_id', 'a.status',
            'a.email as account_email', 'a.security_epoch', 'a.created_at', 'a.deleted_at',
          ])
          .where('u.email', '=', authUserEmail)
          .executeTakeFirst()
      : null;

    let account: Account | null = null;
    let authUserId: string | null = null;
    if (existingMapped !== undefined && existingMapped !== null) {
      account = {
        id: existingMapped.account_id,
        subjectId: existingMapped.subject_id,
        status: existingMapped.status,
        email: existingMapped.account_email,
        securityEpoch: BigInt(existingMapped.security_epoch),
        createdAt: existingMapped.created_at,
        deletedAt: existingMapped.deleted_at,
      };
      authUserId = existingMapped.auth_user_id;
      accountBySubject.set(input.subject, account.id);
    } else {
      account = input.accountId === undefined
        ? (accountBySubject.has(input.subject) ? await existingAccount(accountBySubject.get(input.subject)!) : null)
        : await existingAccount(input.accountId);
      if (!account) {
      const accountId = input.accountId ?? generateOpaqueId();
      const subjectId = generateOpaqueId();
      await options.db.insertInto('accounts').values({
        id: accountId,
        subject_id: subjectId,
        status: 'active',
        email: input.email ?? null,
        security_epoch: 0n,
        created_at: now,
        deleted_at: null,
      }).execute();
      await options.db.insertInto('profiles').values({
        account_id: accountId,
        display_name: input.displayName ?? input.subject,
        avatar_url: null,
        updated_at: now,
      }).execute();
      const existingHandle = await options.db.selectFrom('profile_handles').selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!existingHandle) {
        await options.db.insertInto('profile_handles').values({
          handle: normalizedHandle,
          account_id: accountId,
          created_at: now,
        }).execute();
      }
      account = {
        id: accountId,
        subjectId,
        status: 'active',
        email: input.email ?? null,
        securityEpoch: 0n,
        createdAt: now,
        deletedAt: null,
      };
      if (input.accountId === undefined) accountBySubject.set(input.subject, accountId);
    }

    // Auth user + 1:1 mapping (real schema: auth_users.email UNIQUE,
    // auth_user_account_map.auth_user_id UNIQUE + account_id UNIQUE). A
    // re-issued subject reuses the SAME auth user (a BA user owns many
    // sessions); the account never gains a second auth user or mapping.
    const existingMapping = await options.db.selectFrom('auth_user_account_map').select('auth_user_id')
      .where('account_id', '=', account.id)
      .executeTakeFirst();
    if (authUserId === null) authUserId = existingMapping?.auth_user_id ?? null;
    if (authUserId === null) {
      const existingAuthUser = await options.db.selectFrom('auth_users').select('id')
        .where('email', '=', authUserEmail)
        .executeTakeFirst();
      if (existingAuthUser) {
        authUserId = existingAuthUser.id;
      } else {
        authUserId = `auth-user-${generateOpaqueId()}`;
        await options.db.insertInto('auth_users').values({
          id: authUserId,
          name: input.displayName ?? input.subject,
          email: authUserEmail,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        }).execute();
      }
      await options.db.insertInto('auth_user_account_map').values({
        auth_user_id: authUserId,
        account_id: account.id,
        created_at: now,
      }).execute();
    }
    }

    const material = mintTestSessionMaterial({
      secret,
      sessionExpiresInSeconds,
      now,
      accountId: account.id,
      securityEpoch: account.securityEpoch,
    });
    const protectedToken = sessionTokenProtector.protect(material.token);
    await options.db.insertInto('auth_sessions').values({
      id: material.sessionId,
      expiresAt: new Date(now.getTime() + sessionExpiresInSeconds * 1000),
      token: protectedToken.ciphertext,
      tokenLookupHash: protectedToken.lookupHash,
      createdAt: now,
      updatedAt: now,
      ipAddress: '',
      userAgent: '',
      userId: authUserId,
    }).execute();
    await options.db.insertInto('known_auth_session_metadata').values({
      auth_session_id: material.metadata.authSessionId,
      session_token_hash: material.metadata.sessionTokenHash,
      account_id: material.metadata.accountId,
      idle_expires_at: material.metadata.idleExpiresAt,
      absolute_expires_at: material.metadata.absoluteExpiresAt,
      security_epoch: material.metadata.securityEpoch,
      csrf_token_hash: material.metadata.csrfTokenHash,
      predecessor_session_id: null,
      last_seen_at: material.metadata.lastSeenAt,
      revoked_at: null,
      created_at: material.metadata.createdAt,
    }).execute();

    return toClient(material, account.id, account.subjectId);
  }

  // Serialize concurrent issues: the in-process `accountBySubject` reuse map
  // is not atomic across awaits, so two concurrent `issueTestSession` calls
  // for the same subject would each mint their own account (mirror of the
  // concurrent-OIDC-login convergence contract).
  let issueTail: Promise<unknown> = Promise.resolve();
  function issueSerialized(input: IssueTestSessionInput): Promise<AuthenticatedTestClient> {
    const run = issueTail.then(() => issue(input));
    issueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    authority,
    secret,
    sessionExpiresInSeconds,
    auth,
    issueTestSession: issueSerialized,
  };
}
