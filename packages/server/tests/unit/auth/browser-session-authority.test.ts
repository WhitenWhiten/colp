/**
 * Task A3 unit tests: BrowserSessionAuthority application facade + transport
 * wiring (session-auth / browser-auth-routes facade paths).
 *
 * 假阴性防护:
 * - the cookie parser under test IS the real product admission path: the
 *   app-level tests go through buildApiApp + Fastify inject, so duplicate
 *   cookies / malformed percent-encoding hit the real admission AND the
 *   facade's own fail-closed parser;
 * - the CSRF flow is exercised end-to-end: GET /api/v1/session returns the
 *   derived CSRF, and a real product mutation (PATCH /api/v1/me) is executed
 *   with Origin + that CSRF;
 * - the facade paths never consult the legacy `sessions` rows (a seeded
 *   legacy row must NOT authenticate) and never use the BA user id as the
 *   product subject (actor.account.id is the business account id).
 *
 * 假阳性防护:
 * - the fake Better Auth server resolves cookies the same way BA does
 *   (signed-cookie split, session row, expiry) — an invalid cookie is a real
 *   null, not a stub;
 * - rotation loser convergence is asserted with the SAME cookie value as the
 *   winner, and the predecessor metadata row must be marked revoked.
 */
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import type { AuthUserAccountMapping, IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  createTestOidcTransactionSecrets,
  hashSecret,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
  type Account,
  type Profile,
  type ProfileHandle,
  type Session,
} from '../../../src/modules/identity/index.js';
import {
  BROWSER_SESSION_COOKIE_NAME,
  BROWSER_SESSION_LIVE_CAP,
  BrowserSessionAuthenticationError,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createBrowserSessionAuthority,
  deriveBrowserSessionCsrfTokenRaw,
  parseBrowserSessionCookie,
  rankLiveSessionsForInventory,
  resolveBrowserSessionInventoryLimit,
  selectOldestLiveSessionsToEvict,
  type AuthenticatedBrowserActor,
  type BrowserSessionAuthority,
} from '../../../src/modules/auth/index.js';
import {
  RotationCasConflictError,
  type BrowserSessionAuthorityPorts,
  type BrowserSessionMetadataRow,
  type BrowserSessionMetadataStore,
  type BrowserSessionUnitOfWork,
  type BetterAuthServerPort,
  type MintedSuccessorSession,
} from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { requireSessionActor } from '../../../src/transport/session-auth.js';
import { createMemoryProductCommandReceiptPort, type MemoryProductCommandReceipts } from '../../support/product-http-harness.js';

const FIXED_SIGNATURE = `${'A'.repeat(43)}=`;
const TOKEN_1 = 'token-abcdefghijklmnopqrstuvwxyz01'; // secret-scan: allow 'token-abcdefghijklmnopqrstuvwxyz01'
const TOKEN_2 = 'token-abcdefghijklmnopqrstuvwxyz02'; // secret-scan: allow 'token-abcdefghijklmnopqrstuvwxyz02'

interface MemoryWorld {
  now: Date;
  accounts: Map<string, Account>;
  mappings: Map<string, AuthUserAccountMapping>;
  metadataByTokenHash: Map<string, BrowserSessionMetadataRow>;
  metadataById: Map<string, BrowserSessionMetadataRow>;
  predecessorIndex: Map<string, string>;
  /** token -> Better Auth session record (fake BA server + minted successors). */
  baSessions: Map<string, { id: string; userId: string; token: string; expiresAt: Date; emailVerified?: boolean }>;
  tokenBySessionId: Map<string, string>;
  legacySessions: Map<string, Session>;
  legacySessionsByTokenHash: Map<string, string>;
  touchCalls: number;
  mintCounter: number;
  trustDeviceClears: string[];
}

function createMemoryWorld(now = new Date('2026-07-22T12:00:00.000Z')): MemoryWorld {
  return {
    now,
    accounts: new Map(),
    mappings: new Map(),
    metadataByTokenHash: new Map(),
    metadataById: new Map(),
    predecessorIndex: new Map(),
    baSessions: new Map(),
    tokenBySessionId: new Map(),
    legacySessions: new Map(),
    legacySessionsByTokenHash: new Map(),
    touchCalls: 0,
    mintCounter: 0,
    trustDeviceClears: [],
  };
}

function cookieHeader(value: string): string {
  return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`;
}

function cookieValue(token: string): string {
  return `${token}.${FIXED_SIGNATURE}`;
}

function seedAccount(world: MemoryWorld, account: Account): void {
  world.accounts.set(account.id, account);
}

function seedMapping(world: MemoryWorld, authUserId: string, accountId: string): void {
  world.mappings.set(authUserId, { authUserId, accountId, createdAt: new Date(world.now) });
}

/** Registers a live Better Auth session (as BA would create it). */
function seedBaSession(
  world: MemoryWorld,
  input: { readonly id: string; readonly userId: string; readonly token: string; readonly expiresAt?: Date },
): void {
  world.baSessions.set(input.token, {
    id: input.id,
    userId: input.userId,
    token: input.token,
    expiresAt: input.expiresAt ?? new Date(world.now.getTime() + 86_400_000),
  });
  world.tokenBySessionId.set(input.id, input.token);
}

function seedMetadata(world: MemoryWorld, row: BrowserSessionMetadataRow): void {
  world.metadataByTokenHash.set(row.sessionTokenHash, row);
  world.metadataById.set(row.authSessionId, row);
  if (row.predecessorSessionId !== null) {
    world.predecessorIndex.set(row.predecessorSessionId, row.authSessionId);
  }
}

function seedLegacySession(world: MemoryWorld, rawToken: string, accountId: string): void {
  const session: Session = {
    id: `legacy-${rawToken}`,
    accountId,
    idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
    absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
    csrfTokenHash: hashSecret(deriveBrowserSessionCsrfTokenRaw(rawToken)),
    tokenHash: hashSecret(rawToken),
    securityEpoch: 0n,
    rotatedFromSessionId: null,
    lastSeenAt: new Date(world.now),
    revokedAt: null,
    createdAt: new Date(world.now),
  };
  world.legacySessions.set(session.id, session);
  world.legacySessionsByTokenHash.set(session.tokenHash, session.id);
}

function createMemoryBetterAuthServer(world: MemoryWorld): BetterAuthServerPort {
  return {
    async getSession({ cookie }) {
      const parsed = parseBrowserSessionCookie(cookie);
      if (parsed.kind !== 'present') return null;
      const dot = parsed.value.lastIndexOf('.');
      const token = dot < 1 ? null : parsed.value.slice(0, dot);
      if (token === null) return null;
      const session = world.baSessions.get(token);
      if (!session || session.expiresAt.getTime() <= world.now.getTime()) return null;
      return { ...session, emailVerified: session.emailVerified !== false };
    },
    async signOut({ cookie }) {
      const parsed = parseBrowserSessionCookie(cookie);
      if (parsed.kind !== 'present') return;
      const dot = parsed.value.lastIndexOf('.');
      const token = dot < 1 ? null : parsed.value.slice(0, dot);
      if (token === null) return;
      const session = world.baSessions.get(token);
      if (session) {
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
      }
    },
  };
}

function createMemoryMetadataStore(world: MemoryWorld): BrowserSessionMetadataStore {
  const store: BrowserSessionMetadataStore = {
    async findByTokenHash(tokenHash) {
      return world.metadataByTokenHash.get(tokenHash) ?? null;
    },
    async insert(row) {
      if (row.predecessorSessionId !== null && world.predecessorIndex.has(row.predecessorSessionId)) {
        throw new RotationCasConflictError();
      }
      world.metadataByTokenHash.set(row.sessionTokenHash, row);
      world.metadataById.set(row.authSessionId, row);
      if (row.predecessorSessionId !== null) {
        world.predecessorIndex.set(row.predecessorSessionId, row.authSessionId);
      }
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
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, revokedAt };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async touch(authSessionId, lastSeenAt, idleExpiresAt) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      world.touchCalls += 1;
      const next = { ...row, lastSeenAt, idleExpiresAt };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async findByPredecessor(predecessorSessionId) {
      const id = world.predecessorIndex.get(predecessorSessionId);
      return id ? world.metadataById.get(id) ?? null : null;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      let count = 0;
      for (const [id, row] of world.metadataById) {
        if (row.accountId === accountId && row.revokedAt === null) {
          world.metadataById.set(id, { ...row, revokedAt });
          count += 1;
        }
      }
      return count;
    },
    async mintSuccessorSession({ userId, now }): Promise<MintedSuccessorSession> {
      world.mintCounter += 1;
      const token = `minted-${String(world.mintCounter).padStart(24, '0')}`;
      const id = `minted-session-${world.mintCounter}`;
      const expiresAt = new Date(now.getTime() + 86_400_000);
      world.baSessions.set(token, { id, userId, token, expiresAt });
      world.tokenBySessionId.set(id, token);
      return { session: { id, userId, token, expiresAt }, rawCookieValue: cookieValue(token) };
    },
    async findSuccessorCookie(predecessorSessionId) {
      const id = world.predecessorIndex.get(predecessorSessionId);
      if (!id) return null;
      const token = world.tokenBySessionId.get(id);
      const session = token ? world.baSessions.get(token) : undefined;
      if (!token || !session) return null;
      return {
        session: { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt },
        rawCookieValue: cookieValue(token),
      };
    },
    async deleteAuthSessionsForAccount(accountId) {
      const authUserIds = [...world.mappings.values()]
        .filter((mapping) => mapping.accountId === accountId)
        .map((mapping) => mapping.authUserId);
      let deleted = 0;
      for (const [token, session] of world.baSessions) {
        if (!authUserIds.includes(session.userId)) continue;
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
        const metadata = world.metadataById.get(session.id);
        if (metadata) {
          world.metadataByTokenHash.delete(metadata.sessionTokenHash);
          world.metadataById.delete(session.id);
          if (metadata.predecessorSessionId !== null) world.predecessorIndex.delete(metadata.predecessorSessionId);
        }
        deleted += 1;
      }
      return deleted;
    },
    async revokeOthersForAccount(accountId, keepAuthSessionId, revokedAt) {
      let count = 0;
      for (const [id, row] of world.metadataById) {
        if (row.accountId !== accountId || id === keepAuthSessionId || row.revokedAt !== null) continue;
        world.metadataById.set(id, { ...row, revokedAt });
        count += 1;
      }
      return count;
    },
    async alignMetadataEpoch(authSessionId, securityEpoch) {
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return false;
      const next = { ...row, securityEpoch };
      world.metadataById.set(authSessionId, next);
      world.metadataByTokenHash.set(next.sessionTokenHash, next);
      return true;
    },
    async deleteAuthSessionsForAccountExcept(accountId, keepAuthSessionId) {
      const authUserIds = [...world.mappings.values()]
        .filter((mapping) => mapping.accountId === accountId)
        .map((mapping) => mapping.authUserId);
      let deleted = 0;
      for (const [token, session] of world.baSessions) {
        if (!authUserIds.includes(session.userId) || session.id === keepAuthSessionId) continue;
        world.baSessions.delete(token);
        world.tokenBySessionId.delete(session.id);
        deleted += 1;
      }
      return deleted;
    },
    async listLiveForAccount(accountId, options) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of world.metadataById.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!world.tokenBySessionId.has(row.authSessionId)) continue;
        live.push(row);
      }
      return rankLiveSessionsForInventory(live, resolveBrowserSessionInventoryLimit(options));
    },
    async evictOldestLiveForAccount({ accountId, keepAuthSessionId, now, cap }) {
      const live: BrowserSessionMetadataRow[] = [];
      for (const row of world.metadataById.values()) {
        if (row.accountId !== accountId || row.revokedAt !== null) continue;
        if (!world.tokenBySessionId.has(row.authSessionId)) continue;
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
      const row = world.metadataById.get(authSessionId);
      if (!row || row.revokedAt !== null) return null;
      if (!world.tokenBySessionId.has(authSessionId)) return null;
      return row;
    },
    async deleteAuthSessionById(authSessionId) {
      const token = world.tokenBySessionId.get(authSessionId);
      if (!token) return false;
      world.baSessions.delete(token);
      world.tokenBySessionId.delete(authSessionId);
      return true;
    },
    async deleteTrustDeviceStateForAccount(accountId) {
      world.trustDeviceClears.push(accountId);
      return world.trustDeviceClears.length;
    },
  };
  return store;
}

function createMemoryAccounts(world: MemoryWorld) {
  return {
    async findById(id) {
      return world.accounts.get(id) ?? null;
    },
    async findBySubjectId(subjectId) {
      for (const account of world.accounts.values()) {
        if (account.subjectId === subjectId) return account;
      }
      return null;
    },
    async findByEmail(email) {
      for (const account of world.accounts.values()) {
        if (account.email === email) return account;
      }
      return null;
    },
    async insert(account) {
      world.accounts.set(account.id, account);
    },
    async bumpSecurityEpoch(accountId) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      const next = { ...account, securityEpoch: account.securityEpoch + 1n };
      world.accounts.set(accountId, next);
      return next.securityEpoch;
    },
    async updateEmail(accountId, email) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      world.accounts.set(accountId, { ...account, email });
    },
    async markDeleted(accountId, deletedAt) {
      const account = world.accounts.get(accountId);
      if (!account) throw new Error('missing account');
      world.accounts.set(accountId, { ...account, status: 'deleted', deletedAt, email: null });
    },
  };
}

function createMemorySessions(world: MemoryWorld) {
  return {
    async findById(id) {
      return world.legacySessions.get(id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      const id = world.legacySessionsByTokenHash.get(tokenHash);
      return id ? world.legacySessions.get(id) ?? null : null;
    },
    async findLiveSuccessorByRotatedFrom() {
      return null;
    },
    async insert(session) {
      world.legacySessions.set(session.id, session);
      world.legacySessionsByTokenHash.set(session.tokenHash, session.id);
    },
    async revoke(sessionId, revokedAt) {
      const session = world.legacySessions.get(sessionId);
      if (!session || session.revokedAt !== null) return false;
      world.legacySessions.set(sessionId, { ...session, revokedAt });
      return true;
    },
    async touch() {
      return false;
    },
    async revokeAllForAccount(accountId, revokedAt) {
      let count = 0;
      for (const [id, session] of world.legacySessions) {
        if (session.accountId === accountId && session.revokedAt === null) {
          world.legacySessions.set(id, { ...session, revokedAt });
          count += 1;
        }
      }
      return count;
    },
  };
}

interface MemoryHarness {
  readonly world: MemoryWorld;
  readonly authority: BrowserSessionAuthority;
  readonly unitOfWork: BrowserSessionUnitOfWork;
  readonly betterAuth: BetterAuthServerPort;
}

function createMemoryHarness(now?: Date): MemoryHarness {
  const world = createMemoryWorld(now);
  const betterAuth = createMemoryBetterAuthServer(world);
  const store = createMemoryMetadataStore(world);
  const accounts = createMemoryAccounts(world);
  const sessions = createMemorySessions(world);
  const unitOfWork: BrowserSessionUnitOfWork = {
    async execute<Result>(work: (ports: BrowserSessionAuthorityPorts) => Promise<Result>): Promise<Result> {
      return work({
        store,
        mappings: {
          async findByAuthUserId(authUserId) {
            return world.mappings.get(authUserId) ?? null;
          },
          async insert(mapping) {
            world.mappings.set(mapping.authUserId, mapping);
          },
        },
        accounts,
        sessions,
        clock: { now: async () => new Date(world.now) },
        revokeOAuthRefreshTokensForAccount: async () => 0,
      });
    },
  };
  return {
    world,
    authority: createBrowserSessionAuthority({ unitOfWork, betterAuth }),
    unitOfWork,
    betterAuth,
  };
}

/** Seeds one fully usable session: account + mapping + BA session + metadata. */
function seedUsableSession(
  world: MemoryWorld,
  options: {
    readonly token?: string;
    readonly baSessionId?: string;
    readonly authUserId?: string;
    readonly accountId?: string;
    readonly createdAtAgoMs?: number;
    readonly idleExpiresAt?: Date;
    readonly absoluteExpiresAt?: Date;
    readonly securityEpoch?: bigint;
    readonly lastSeenAt?: Date;
    readonly revoked?: boolean;
    readonly csrfTokenHashOverride?: string;
  } = {},
): { readonly token: string; readonly cookie: string; readonly accountId: string } {
  const token = options.token ?? TOKEN_1;
  const accountId = options.accountId ?? 'acct-1';
  const authUserId = options.authUserId ?? 'ba-user-1';
  const now = new Date(world.now);
  const absoluteExpiresAt = options.absoluteExpiresAt ?? new Date(now.getTime() + 30 * 86_400_000);
  const idleExpiresAt = options.idleExpiresAt ?? new Date(now.getTime() + 86_400_000);
  seedAccount(world, {
    id: accountId,
    subjectId: `subj-${accountId}`,
    status: 'active',
    email: `${accountId}@example.test`,
    securityEpoch: options.securityEpoch ?? 0n,
    createdAt: now,
    deletedAt: null,
  });
  seedMapping(world, authUserId, accountId);
  seedBaSession(world, {
    id: options.baSessionId ?? 'ba-session-1',
    userId: authUserId,
    token,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  seedMetadata(world, {
    authSessionId: options.baSessionId ?? 'ba-session-1',
    sessionTokenHash: browserSessionTokenHash(token),
    accountId,
    idleExpiresAt,
    absoluteExpiresAt,
    securityEpoch: options.securityEpoch ?? 0n,
    csrfTokenHash: options.csrfTokenHashOverride
      ?? browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
    predecessorSessionId: null,
    lastSeenAt: options.lastSeenAt ?? now,
    revokedAt: options.revoked === true ? now : null,
    createdAt: new Date(now.getTime() - (options.createdAtAgoMs ?? 0)),
  });
  return { token, cookie: cookieValue(token), accountId };
}

function extraSessionToken(index: number): string {
  return `extra-token-${String(index).padStart(20, '0')}`;
}

/** Extra live sessions `ba-session-2`… with older last_seen than the current session. */
function seedExtraLiveSessions(world: MemoryWorld, count: number): string[] {
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = offset + 2;
    const id = `ba-session-${index}`;
    const token = extraSessionToken(index);
    const lastSeenAt = new Date(world.now.getTime() - (offset + 1) * 1_000);
    seedBaSession(world, { id, userId: 'ba-user-1', token });
    seedMetadata(world, {
      authSessionId: id,
      sessionTokenHash: browserSessionTokenHash(token),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
      predecessorSessionId: null,
      lastSeenAt,
      revokedAt: null,
      createdAt: lastSeenAt,
    });
    ids.push(id);
  }
  return ids;
}

function countLiveForAccount(world: MemoryWorld, accountId: string): number {
  let count = 0;
  for (const row of world.metadataById.values()) {
    if (row.accountId !== accountId || row.revokedAt !== null) continue;
    if (!world.tokenBySessionId.has(row.authSessionId)) continue;
    count += 1;
  }
  return count;
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

describe('BrowserSessionAuthority cookie admission', () => {
  test('absent, duplicate, malformed-encoding and malformed-value cookies fail closed', async () => {
    const { authority } = createMemoryHarness();
    assert.equal(await authority.authenticate({}), null);
    assert.equal(await authority.authenticate({ cookie: undefined }), null);
    // Duplicate session cookie in one header: BA 1.6.29 is first-wins, the
    // authority must reject (R3).
    assert.equal(
      await authority.authenticate({ cookie: `${cookieHeader(cookieValue(TOKEN_1))}; ${cookieHeader(cookieValue(TOKEN_2))}` }),
      null,
    );
    // Duplicate header lines arrive comma-joined after admission; the parser
    // treats a second occurrence as a parse error.
    assert.equal(
      await authority.authenticate({ cookie: `${cookieHeader(cookieValue(TOKEN_1))}, ${cookieHeader(cookieValue(TOKEN_2))}` }),
      null,
    );
    // Malformed percent-encoding.
    assert.equal(await authority.authenticate({ cookie: `${BROWSER_SESSION_COOKIE_NAME}=%zz` }), null);
    // Wrong cookie name (case-sensitive contract) is ignored -> absent.
    assert.equal(await authority.authenticate({ cookie: '__host-known_session=x.y' }), null);
    // Value without the <token>.<signature> shape.
    assert.equal(await authority.authenticate({ cookie: `${BROWSER_SESSION_COOKIE_NAME}=notoken` }), null);
    // Unknown session: valid shape, no BA session row.
    assert.equal(
      await authority.authenticate({ cookie: cookieHeader(`${TOKEN_2}.${FIXED_SIGNATURE}`) }),
      null,
    );
  });
});

describe('BrowserSessionAuthority authenticate', () => {
  test('an unverified BA session is not a product actor', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);
    const session = world.baSessions.get(TOKEN_1);
    assert.ok(session);
    world.baSessions.set(TOKEN_1, { ...session, emailVerified: false });

    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
    assert.deepEqual(await authority.bootstrap({ cookie: cookieHeader(cookie) }), {
      authenticated: false,
      verificationRequired: true,
    });
    await assert.rejects(
      () => authority.requireMutationActor({ cookie: cookieHeader(cookie) }, { touch: false }),
      (error: unknown) => error instanceof BrowserSessionAuthenticationError
        && error.code === 'verification_required',
    );
  });

  test('valid session returns the product actor with the legacy-compatible session view', async () => {
    const { world, authority } = createMemoryHarness();
    const { token, cookie, accountId } = seedUsableSession(world);

    const actor = await authority.authenticate({ cookie: cookieHeader(cookie) });
    assert.ok(actor, 'expected an authenticated actor');
    // The product subject is the business account id — NEVER the BA user id.
    assert.equal(actor.account.id, accountId);
    assert.notEqual(actor.account.id, 'ba-user-1');
    assert.equal(actor.session.id, 'ba-session-1');
    assert.equal(actor.session.accountId, accountId);
    assert.equal(actor.session.tokenHash, browserSessionTokenHash(token));
    assert.equal(actor.session.csrfTokenHash, browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)));
    assert.equal(actor.session.absoluteExpiresAt.getTime(), world.now.getTime() + 30 * 86_400_000);
    assert.equal(actor.session.revokedAt, null);
    // No BA type leaks into the actor shape.
    assert.equal((actor as AuthenticatedBrowserActor & { userId?: unknown }).userId, undefined);
  });

  test('a live BA session without metadata never authenticates; legacy sessions rows are not consulted', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie, accountId } = seedUsableSession(world);
    // Remove the metadata row (orphan BA session) and add a legacy product
    // session row for the same token hash: neither may authenticate.
    world.metadataByTokenHash.delete(browserSessionTokenHash(TOKEN_1));
    world.metadataById.delete('ba-session-1');
    seedLegacySession(world, TOKEN_1, accountId);

    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
    assert.equal((await authority.bootstrap({ cookie: cookieHeader(cookie) })).authenticated, false);
  });

  test('revoked metadata fails closed', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, { revoked: true });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('idle-expired session fails closed and records the revoke fact', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, {
      idleExpiresAt: new Date(world.now.getTime() - 1000),
    });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
    assert.notEqual(world.metadataById.get('ba-session-1')?.revokedAt, null);
  });

  test('absolute-expired session fails closed even with a future idle window', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, {
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() - 1000),
    });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('security epoch mismatch fails closed', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, { securityEpoch: 0n });
    const account = world.accounts.get('acct-1');
    assert.ok(account);
    world.accounts.set('acct-1', { ...account, securityEpoch: 1n });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('disabled and deleted accounts fail closed', async () => {
    for (const status of ['disabled', 'deleted'] as const) {
      const { world, authority } = createMemoryHarness();
      const { cookie } = seedUsableSession(world);
      const account = world.accounts.get('acct-1');
      assert.ok(account);
      world.accounts.set('acct-1', {
        ...account,
        status,
        ...(status === 'deleted' ? { deletedAt: new Date(world.now) } : {}),
      });
      assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null, status);
    }
  });

  test('missing mapping fails closed even though the BA session is live', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);
    world.mappings.delete('ba-user-1');
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('tampered stored CSRF digest fails closed', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, {
      csrfTokenHashOverride: browserSessionCsrfTokenHash('attacker-chosen-csrf'),
    });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('touch is throttled to the minimum interval', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);
    const base = world.touchCalls;

    await authority.authenticate({ cookie: cookieHeader(cookie) }, { touch: true });
    assert.equal(world.touchCalls, base, 'no touch write below the interval');

    world.now = new Date(world.now.getTime() + 30_000);
    await authority.authenticate({ cookie: cookieHeader(cookie) }, { touch: true });
    assert.equal(world.touchCalls, base, 'still below the 60s touch interval');

    world.now = new Date(world.now.getTime() + 31_000);
    const actor = await authority.authenticate({ cookie: cookieHeader(cookie) }, { touch: true });
    assert.ok(actor);
    assert.equal(world.touchCalls, base + 1, 'touch write fires once the interval is met');
    assert.equal(actor.session.lastSeenAt.getTime(), world.now.getTime());
    // Slid idle is bounded by the absolute deadline.
    assert.equal(actor.session.idleExpiresAt.getTime(), world.now.getTime() + 86_400_000);

    // A pure read (touch: false) never writes.
    await authority.authenticate({ cookie: cookieHeader(cookie) }, { touch: false });
    assert.equal(world.touchCalls, base + 1);
  });

  test('requireMutationActor throws the stable authentication error', async () => {
    const { authority } = createMemoryHarness();
    await assert.rejects(
      () => authority.requireMutationActor({ cookie: cookieHeader(cookieValue(TOKEN_2)) }),
      (error: unknown) => {
        assert.ok(error instanceof BrowserSessionAuthenticationError);
        assert.equal(error.code, 'authentication_required');
        return true;
      },
    );
  });
});

describe('BrowserSessionAuthority bootstrap and rotation', () => {
  test('below the rotation threshold re-issues the derived CSRF without rotating', async () => {
    const { world, authority } = createMemoryHarness();
    const { token, cookie } = seedUsableSession(world, { createdAtAgoMs: 60_000 });

    const result = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(result.authenticated);
    assert.equal(result.rotated, false);
    assert.equal(result.csrfToken, deriveBrowserSessionCsrfTokenRaw(token));
    assert.equal(result.rotatedCookieValue, undefined);
    assert.equal(world.mintCounter, 0, 'no successor minted below the threshold');
    // Set-Cookie is only produced when rotated (transport contract).
    assert.equal(result.authenticated && result.rotated, false);
  });

  test('below the rotation threshold does not throttle-touch last_seen', async () => {
    const lastSeenAt = new Date('2026-07-22T11:58:00.000Z');
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, {
      createdAtAgoMs: 60_000,
      lastSeenAt,
    });
    assert.ok(world.now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_MIN_INTERVAL_MS);

    const result = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(result.authenticated);
    assert.equal(result.rotated, false);
    assert.equal(world.touchCalls, 0);
    assert.equal(world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), lastSeenAt.getTime());
  });

  test('at/above the rotation age the bootstrap rotates with a single winner successor', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, { createdAtAgoMs: 16 * 60_000 });

    const result = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(result.authenticated);
    assert.equal(result.rotated, true);
    assert.ok(result.rotatedCookieValue);
    assert.equal(world.mintCounter, 1);
    // The rotated cookie is a new signed successor, not the old cookie.
    assert.notEqual(result.rotatedCookieValue, cookie);
    // Predecessor metadata is retired (revoke fact) and the successor row
    // carries the predecessor CAS link.
    const oldMetadata = world.metadataById.get('ba-session-1');
    assert.notEqual(oldMetadata?.revokedAt, null);
    const successorToken = result.rotatedCookieValue.slice(0, result.rotatedCookieValue.lastIndexOf('.'));
    const successorMetadata = world.metadataByTokenHash.get(browserSessionTokenHash(successorToken));
    assert.ok(successorMetadata);
    assert.equal(successorMetadata.predecessorSessionId, 'ba-session-1');
    // Absolute lifetime is preserved from the predecessor — never extended.
    assert.equal(
      successorMetadata.absoluteExpiresAt.getTime(),
      world.now.getTime() + 30 * 86_400_000,
    );
    // The new cookie authenticates through the real (fake-BA) server API.
    const actor = await authority.authenticate({ cookie: cookieHeader(result.rotatedCookieValue!) });
    assert.ok(actor);
    assert.equal(actor.account.id, 'acct-1');
  });

  test('a rotated-away predecessor cookie converges to the winner cookie', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, { createdAtAgoMs: 16 * 60_000 });

    const winner = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(winner.authenticated && winner.rotated && winner.rotatedCookieValue);

    // Second bootstrap with the OLD cookie: metadata is revoked, but the live
    // successor must resolve — the loser returns the winner's cookie value.
    const loser = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(loser.authenticated, 'loser must converge to the winner');
    assert.equal(loser.rotated, true);
    assert.equal(loser.rotatedCookieValue, winner.rotatedCookieValue);
    assert.equal(loser.csrfToken, winner.csrfToken);
    assert.equal(world.mintCounter, 1, 'the loser must not mint a second successor');
  });

  test('a CAS-conflict during the rotation write converges without minting twice', async () => {
    const { world, authority, unitOfWork } = createMemoryHarness();
    const { cookie } = seedUsableSession(world, { createdAtAgoMs: 16 * 60_000 });

    // Pre-claim the predecessor exactly like a concurrent winner would: a
    // minted successor + metadata row with the predecessor link (the partial
    // unique index semantics), WITHOUT retiring the predecessor yet — so the
    // bootstrap reaches the rotation branch and its insert loses the CAS.
    await unitOfWork.execute(async (ports) => {
      const minted = await ports.store.mintSuccessorSession({ userId: 'ba-user-1', now: new Date(world.now) });
      const rawCsrf = deriveBrowserSessionCsrfTokenRaw(minted.session.token);
      await ports.store.insert({
        authSessionId: minted.session.id,
        sessionTokenHash: browserSessionTokenHash(minted.session.token),
        accountId: 'acct-1',
        idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
        absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
        securityEpoch: 0n,
        csrfTokenHash: browserSessionCsrfTokenHash(rawCsrf),
        predecessorSessionId: 'ba-session-1',
        lastSeenAt: new Date(world.now),
        revokedAt: null,
        createdAt: new Date(world.now),
      });
    });

    const result = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(result.authenticated, 'CAS loser must converge to the pre-claimed winner');
    assert.equal(result.rotated, true);
    assert.ok(result.rotatedCookieValue);
    // Exactly one successor exists for the predecessor (the pre-claimed one).
    assert.equal(world.predecessorIndex.get('ba-session-1') !== undefined, true);
    const successorId = world.predecessorIndex.get('ba-session-1');
    assert.ok(successorId);
    const successorToken = world.tokenBySessionId.get(successorId);
    assert.ok(successorToken);
    assert.equal(result.rotatedCookieValue, cookieValue(successorToken));
  });

  test('bootstrap fails closed for invalid/expired/revoked sessions', async () => {
    const { world, authority } = createMemoryHarness();
    assert.deepEqual(await authority.bootstrap({}), { authenticated: false });
    assert.deepEqual(await authority.bootstrap({ cookie: `${BROWSER_SESSION_COOKIE_NAME}=%zz` }), { authenticated: false });

    const { cookie } = seedUsableSession(world, { revoked: true });
    assert.deepEqual(await authority.bootstrap({ cookie: cookieHeader(cookie) }), { authenticated: false });

    const idleExpired = createMemoryHarness();
    const { cookie: idleCookie } = seedUsableSession(idleExpired.world, {
      idleExpiresAt: new Date(idleExpired.world.now.getTime() - 1000),
    });
    assert.deepEqual(await idleExpired.authority.bootstrap({ cookie: cookieHeader(idleCookie) }), { authenticated: false });
  });
});

describe('BrowserSessionAuthority signOut and revokeAll', () => {
  test('signOut revokes the BA session, records the revoke fact and is idempotent', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);

    await authority.signOut({ cookie: cookieHeader(cookie) });
    assert.equal(world.baSessions.has(TOKEN_1), false, 'BA session row must be gone');
    assert.notEqual(world.metadataById.get('ba-session-1')?.revokedAt, null);
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);

    // Idempotent: second logout with the same (now dead) cookie is a no-op.
    await authority.signOut({ cookie: cookieHeader(cookie) });
    // Logout with an absent/invalid cookie is a no-op.
    await authority.signOut({});
    await authority.signOut({ cookie: `${BROWSER_SESSION_COOKIE_NAME}=%zz` });
  });

  test('revokeAll bumps the epoch and revokes BA sessions, metadata and legacy sessions', async () => {
    const { world, authority } = createMemoryHarness();
    seedUsableSession(world);
    seedBaSession(world, { id: 'ba-session-2', userId: 'ba-user-1', token: TOKEN_2 });
    seedMetadata(world, {
      authSessionId: 'ba-session-2',
      sessionTokenHash: browserSessionTokenHash(TOKEN_2),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(TOKEN_2)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now),
      revokedAt: null,
      createdAt: new Date(world.now),
    });
    seedLegacySession(world, 'legacy-raw-token-abcdefghijklmnopqrstuvwxyz', 'acct-1');

    const result = await authority.revokeAll('acct-1');
    assert.equal(result.securityEpoch, 1n);
    assert.equal(result.revokedAuthSessions, 2);
    assert.equal(result.revokedLegacySessions, 1);
    assert.equal(world.baSessions.size, 0);
    assert.equal(world.metadataById.size, 0);
    assert.deepEqual(world.trustDeviceClears, ['acct-1']);
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 1n);
    assert.equal(
      [...world.legacySessions.values()].every((session) => session.revokedAt !== null),
      true,
    );
    // The bumped epoch invalidates every downstream binding snapshot.
    assert.notEqual(world.accounts.get('acct-1')?.securityEpoch, 0n);

    await assert.rejects(
      () => authority.revokeAll('missing-account'),
      (error: unknown) => {
        assert.ok(error instanceof BrowserSessionAuthenticationError);
        assert.equal(error.code, 'account_not_found');
        return true;
      },
    );
  });

  test('revokeOthersKeepingCurrent bumps the epoch, keeps the current session, and revokes the rest', async () => {
    const { world, authority } = createMemoryHarness();
    seedUsableSession(world);
    seedBaSession(world, { id: 'ba-session-2', userId: 'ba-user-1', token: TOKEN_2 });
    seedMetadata(world, {
      authSessionId: 'ba-session-2',
      sessionTokenHash: browserSessionTokenHash(TOKEN_2),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(TOKEN_2)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now),
      revokedAt: null,
      createdAt: new Date(world.now),
    });
    seedLegacySession(world, 'legacy-raw-token-abcdefghijklmnopqrstuvwxyz', 'acct-1');

    const result = await authority.revokeOthersKeepingCurrent({
      authUserId: 'ba-user-1',
      currentAuthSessionId: 'ba-session-1',
    });
    assert.equal(result.securityEpoch, 1n);
    assert.equal(world.baSessions.size, 1);
    assert.equal([...world.baSessions.values()][0]?.id, 'ba-session-1');
    assert.equal(world.metadataById.get('ba-session-1')?.securityEpoch, 1n);
    assert.equal(world.metadataById.get('ba-session-1')?.revokedAt, null);
    assert.ok(world.metadataById.get('ba-session-2')?.revokedAt);
    assert.equal(
      [...world.legacySessions.values()].every((session) => session.revokedAt !== null),
      true,
    );
    assert.deepEqual(world.trustDeviceClears, ['acct-1']);
  });

  test('listLiveSessions returns both sessions with current flag and never a token', async () => {
    const { world, authority } = createMemoryHarness();
    const first = seedUsableSession(world);
    seedBaSession(world, { id: 'ba-session-2', userId: 'ba-user-1', token: TOKEN_2 });
    seedMetadata(world, {
      authSessionId: 'ba-session-2',
      sessionTokenHash: browserSessionTokenHash(TOKEN_2),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(TOKEN_2)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now.getTime() - 60_000),
      revokedAt: null,
      createdAt: new Date(world.now.getTime() - 60_000),
    });

    const listed = await authority.listLiveSessions({
      accountId: first.accountId,
      currentAuthSessionId: 'ba-session-1',
    });
    assert.equal(listed.length, 2);
    const current = listed.find((item) => item.id === 'ba-session-1');
    const other = listed.find((item) => item.id === 'ba-session-2');
    assert.equal(current?.current, true);
    assert.equal(other?.current, false);
    const fixture = {
      sessions: listed.map((item) => ({
        id: item.id,
        createdAt: item.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        updatedAt: item.updatedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        current: item.current,
      })),
    };
    assert.equal(JSON.stringify(fixture).includes('token'), false, 'R9: list JSON must not include token');
    for (const item of fixture.sessions) {
      assert.equal('token' in item, false);
      assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'current', 'id', 'updatedAt']);
    }
  });

  test('revokeSessionById of the other session leaves the current session authenticating', async () => {
    const { world, authority } = createMemoryHarness();
    const first = seedUsableSession(world);
    seedBaSession(world, { id: 'ba-session-2', userId: 'ba-user-1', token: TOKEN_2 });
    seedMetadata(world, {
      authSessionId: 'ba-session-2',
      sessionTokenHash: browserSessionTokenHash(TOKEN_2),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(TOKEN_2)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now),
      revokedAt: null,
      createdAt: new Date(world.now),
    });

    const revoked = await authority.revokeSessionById({
      request: { cookie: cookieHeader(first.cookie) },
      sessionId: 'ba-session-2',
      accountId: first.accountId,
      currentAuthSessionId: 'ba-session-1',
    });
    assert.equal(revoked.kind, 'other');
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 0n, 'revoke-one must not bump security_epoch');
    assert.ok(await authority.authenticate({ cookie: cookieHeader(first.cookie) }));
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookieValue(TOKEN_2)) }), null);
    assert.equal(world.tokenBySessionId.has('ba-session-2'), false);
  });
});

describe('P-07 live session inventory cap', () => {
  test('listLiveSessions returns at most 50 newest last_seen rows with current flag', async () => {
    const { world, authority } = createMemoryHarness();
    const first = seedUsableSession(world);
    const extras = seedExtraLiveSessions(world, 50);
    assert.equal(countLiveForAccount(world, first.accountId), 51);

    const listed = await authority.listLiveSessions({
      accountId: first.accountId,
      currentAuthSessionId: 'ba-session-1',
    });
    assert.equal(listed.length, BROWSER_SESSION_LIVE_CAP);
    assert.equal(listed[0]?.id, 'ba-session-1');
    assert.equal(listed[0]?.current, true);
    assert.equal(listed.some((item) => item.current && item.id !== 'ba-session-1'), false);
    assert.equal(listed.some((item) => item.id === extras[extras.length - 1]), false, 'oldest last_seen is dropped by LIMIT');
    for (let index = 1; index < listed.length; index += 1) {
      const newer = listed[index - 1]!;
      const older = listed[index]!;
      assert.ok(newer.updatedAt.getTime() >= older.updatedAt.getTime());
    }
  });

  test('evictOldestLiveForAccount kicks oldest until cap; kept session stays live', async () => {
    const { world, unitOfWork } = createMemoryHarness();
    const first = seedUsableSession(world);
    const extras = seedExtraLiveSessions(world, 50);
    const oldestId = extras[extras.length - 1]!;
    assert.equal(countLiveForAccount(world, first.accountId), 51);

    const evicted = await unitOfWork.execute((ports) => ports.store.evictOldestLiveForAccount({
      accountId: first.accountId,
      keepAuthSessionId: 'ba-session-1',
      now: new Date(world.now),
      cap: BROWSER_SESSION_LIVE_CAP,
    }));
    assert.equal(evicted, 1);
    assert.equal(countLiveForAccount(world, first.accountId), BROWSER_SESSION_LIVE_CAP);
    assert.ok(world.metadataById.get(oldestId)?.revokedAt);
    assert.equal(world.tokenBySessionId.has(oldestId), false);
    assert.equal(world.metadataById.get('ba-session-1')?.revokedAt, null);
    assert.equal(world.tokenBySessionId.has('ba-session-1'), true);
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 0n);
  });

  test('insert of a 51st live session kicks the oldest and keeps the new row', async () => {
    const { world, unitOfWork } = createMemoryHarness();
    seedUsableSession(world);
    const extras = seedExtraLiveSessions(world, 49);
    assert.equal(countLiveForAccount(world, 'acct-1'), 50);
    const oldestId = extras[extras.length - 1]!;
    const newId = 'ba-session-51';
    const newToken = extraSessionToken(51);
    seedBaSession(world, { id: newId, userId: 'ba-user-1', token: newToken });

    await unitOfWork.execute((ports) => ports.store.insert({
      authSessionId: newId,
      sessionTokenHash: browserSessionTokenHash(newToken),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(newToken)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now),
      revokedAt: null,
      createdAt: new Date(world.now),
    }));

    assert.equal(countLiveForAccount(world, 'acct-1'), BROWSER_SESSION_LIVE_CAP);
    assert.ok(world.metadataById.get(oldestId)?.revokedAt);
    assert.equal(world.tokenBySessionId.has(oldestId), false);
    assert.equal(world.metadataById.get(newId)?.revokedAt, null);
    assert.equal(world.tokenBySessionId.has(newId), true);
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 0n);
  });

  test('rotation insert does not kick another live session when already at cap', async () => {
    const { world, authority } = createMemoryHarness();
    seedUsableSession(world, { createdAtAgoMs: 16 * 60_000 });
    const extras = seedExtraLiveSessions(world, 49);
    assert.equal(countLiveForAccount(world, 'acct-1'), 50);

    const result = await authority.bootstrap({ cookie: cookieHeader(cookieValue(TOKEN_1)) });
    assert.ok(result.authenticated && result.rotated);

    assert.equal(countLiveForAccount(world, 'acct-1'), 50);
    assert.notEqual(world.metadataById.get('ba-session-1')?.revokedAt, null);
    for (const extraId of extras) {
      assert.equal(world.metadataById.get(extraId)?.revokedAt, null, extraId);
      assert.equal(world.tokenBySessionId.has(extraId), true, extraId);
    }
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 0n);
  });
});

/** Memory identity ports for the app-level product mutation tests. */
function createMemoryIdentityPorts(
  world: MemoryWorld,
  state: { readonly profiles: Map<string, Profile>; readonly handles: Map<string, ProfileHandle>; readonly receipts: MemoryProductCommandReceipts },
): IdentityPorts {
  const accounts = createMemoryAccounts(world);
  const sessions = createMemorySessions(world);
  const { profiles, handles, receipts } = state;
  const now = () => new Date(world.now);
  return {
    clock: { now },
    accounts,
    sessions,
    accountIdentities: {
      async findByIssuerSubject() {
        return null;
      },
      async findByAccountId() {
        return null;
      },
      async insert() {
        // no-op
      },
      async insertIfAbsent(identity) {
        return identity;
      },
    },
    profiles: {
      async findByAccountId(accountId) {
        return profiles.get(accountId) ?? null;
      },
      async insert(profile) {
        profiles.set(profile.accountId, profile);
      },
      async update(profile) {
        profiles.set(profile.accountId, profile);
      },
    },
    handles: {
      async findByHandle(handle) {
        return handles.get(handle) ?? null;
      },
      async findByAccountId(accountId) {
        for (const row of handles.values()) {
          if (row.accountId === accountId) return row;
        }
        return null;
      },
      async insert(handle) {
        if (handles.has(handle.handle)) throw new Error('handle taken');
        handles.set(handle.handle, handle);
      },
      async tryInsert(handle) {
        if (handles.has(handle.handle)) return false;
        for (const row of handles.values()) {
          if (row.accountId === handle.accountId) return false;
        }
        handles.set(handle.handle, handle);
        return true;
      },
      async deleteByAccountId(accountId) {
        for (const [handle, row] of handles) {
          if (row.accountId === accountId) {
            handles.delete(handle);
            return true;
          }
        }
        return false;
      },
      async deleteByHandle(handle) {
        return handles.delete(handle);
      },
    },
    oidcLoginTransactions: {
      async insert() {},
      async consume() {
        return null;
      },
      async findByState() {
        return null;
      },
      async deleteByState() {
        return false;
      },
    },
    oidcTransactionSecrets: createTestOidcTransactionSecrets(),
    receipts: createMemoryProductCommandReceiptPort(receipts),
  };
}

function createAppHarness(now?: Date) {
  const harness = createMemoryHarness(now);
  const identityState = {
    profiles: new Map<string, Profile>(),
    handles: new Map<string, ProfileHandle>(),
    receipts: new Map() as MemoryProductCommandReceipts,
  };
  const identityUnitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(createMemoryIdentityPorts(harness.world, identityState)),
  };
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const app = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: harness.authority,
  });
  return { app, world: harness.world, authority: harness.authority, identityState };
}

/** Seeds the business profile + handle rows the /me views require. */
function seedIdentityProfile(
  identityState: { readonly profiles: Map<string, Profile>; readonly handles: Map<string, ProfileHandle> },
  accountId: string,
  displayName: string,
): void {
  identityState.profiles.set(accountId, { accountId, displayName, avatarUrl: null, about: '', updatedAt: new Date() });
  identityState.handles.set(`handle_${accountId}`, { handle: `handle_${accountId}`, accountId, createdAt: new Date() });
}

function firstSetCookie(header: string | string[] | undefined): string {
  assert.ok(header, 'expected Set-Cookie header');
  return Array.isArray(header) ? header[0]! : header;
}

describe('browser auth transport with the BrowserSessionAuthority', () => {
  test('GET /api/v1/session returns the derived CSRF; PATCH /me executes a real product mutation', async () => {
    const { app, world, identityState } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world);
    seedIdentityProfile(identityState, 'acct-1', 'Profile One');

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(sessionResponse.statusCode, 200);
    const sessionBody = sessionResponse.json() as {
      authenticated: boolean;
      csrfToken: string;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    };
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.csrfToken, deriveBrowserSessionCsrfTokenRaw(TOKEN_1));
    assert.ok(sessionBody.idleExpiresAt.endsWith('Z'));
    assert.ok(sessionBody.absoluteExpiresAt.endsWith('Z'));
    assert.equal(sessionResponse.headers['set-cookie'], undefined, 'no rotation below the threshold');

    const baseHeaders = {
      cookie: cookieHeader(cookie),
      origin: 'https://app.example.test',
      'x-csrf-token': sessionBody.csrfToken,
      'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
      'content-type': 'application/json',
    };

    // Real product mutation through the facade: no CSRF -> 403, wrong CSRF -> 403.
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie), origin: 'https://app.example.test', 'content-type': 'application/json', 'known-command-id': '123e4567-e89b-42d3-a456-426614174000' },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((noCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const wrongCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { ...baseHeaders, 'x-csrf-token': 'attacker-token' },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(wrongCsrf.statusCode, 403);
    assert.equal((wrongCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Origin missing / mismatched -> 403.
    const noOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie), 'x-csrf-token': sessionBody.csrfToken, 'content-type': 'application/json', 'known-command-id': '123e4567-e89b-42d3-a456-426614174000' },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((noOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const badOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { ...baseHeaders, origin: 'https://evil.example' },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(badOrigin.statusCode, 403);
    assert.equal((badOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Valid Origin + CSRF -> the mutation goes through and persists.
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: baseHeaders, payload: { handle: 'after_user', displayName: 'After' } });
    assert.equal(updated.statusCode, 200);
    const body = updated.json() as { profile: { handle: string; displayName: string } };
    assert.equal(body.profile.handle, 'after_user');
    assert.equal(body.profile.displayName, 'After');

    // GET /me sees the persisted state.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader(cookie) } });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { account: { email: string | null } }).account.email, 'acct-1@example.test');
  });

  // P8 product wall: an unverified BA session must not be a product actor on
  // /session, /me, or mutations. Deleting the emailVerified checks in
  // browser-session-authority.ts must fail this test. Library signed-out UX
  // is already pinned in Library.test.tsx ('asks signed-out visitors to log in...').
  test('an unverified BA session is not a product actor on /session, /me, or PATCH /me', async () => {
    const { app, world, identityState } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world);
    seedIdentityProfile(identityState, 'acct-1', 'Profile One');
    const session = world.baSessions.get(TOKEN_1);
    assert.ok(session);
    world.baSessions.set(TOKEN_1, { ...session, emailVerified: false });

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(sessionResponse.statusCode, 200);
    const sessionBody = sessionResponse.json() as {
      authenticated: boolean;
      csrfToken?: string;
      verificationRequired?: boolean;
    };
    assert.equal(sessionBody.authenticated, false);
    assert.equal(sessionBody.csrfToken, undefined);
    assert.deepEqual(sessionBody, { authenticated: false, verificationRequired: true });

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(me.statusCode, 403);
    assert.equal((me.json() as { error: { code: string } }).error.code, 'verification_required');

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: {
        cookie: cookieHeader(cookie),
        origin: 'https://app.example.test',
        'x-csrf-token': deriveBrowserSessionCsrfTokenRaw(TOKEN_1),
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'application/json',
      },
      payload: { handle: 'after_user', displayName: 'After' },
    });
    assert.equal(patched.statusCode, 403);
    assert.equal((patched.json() as { error: { code: string } }).error.code, 'verification_required');
    assert.equal(identityState.profiles.get('acct-1')?.displayName, 'Profile One');
    assert.equal(identityState.handles.has('after_user'), false);
  });

  test('a self-hosted unverified session is a product actor while emailVerified stays false', async () => {
    const previous = process.env.KNOWN_EDITION;
    process.env.KNOWN_EDITION = 'self-hosted';
    try {
      const { app, world, identityState } = createAppHarness();
      apps.push(app);
      const { cookie } = seedUsableSession(world);
      seedIdentityProfile(identityState, 'acct-1', 'Profile One');
      const session = world.baSessions.get(TOKEN_1);
      assert.ok(session);
      world.baSessions.set(TOKEN_1, { ...session, emailVerified: false });

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(cookie) },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(world.baSessions.get(TOKEN_1)?.emailVerified, false);

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: {
          cookie: cookieHeader(cookie),
          origin: 'https://app.example.test',
          'x-csrf-token': deriveBrowserSessionCsrfTokenRaw(TOKEN_1),
          'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
          'content-type': 'application/json',
        },
        payload: { handle: 'after_user', displayName: 'After' },
      });
      assert.equal(patched.statusCode, 200);
      assert.equal(identityState.profiles.get('acct-1')?.displayName, 'After');
    } finally {
      if (previous === undefined) delete process.env.KNOWN_EDITION;
      else process.env.KNOWN_EDITION = previous;
    }
  });

  test('DELETE /api/v1/session requires Origin+CSRF and logout is idempotent', async () => {
    const { app, world, authority } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world);
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    const csrfToken = (sessionResponse.json() as { csrfToken: string }).csrfToken;

    const badLogout = await app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie: cookieHeader(cookie) } });
    assert.equal(badLogout.statusCode, 403);
    assert.equal((badLogout.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie), origin: 'https://app.example.test', 'x-csrf-token': csrfToken },
    });
    assert.equal(logout.statusCode, 204);
    assert.match(firstSetCookie(logout.headers['set-cookie']), /__Host-known_session=;.*Max-Age=0/u);
    assert.equal(world.baSessions.has(TOKEN_1), false);

    // Idempotent second logout with the same cookie.
    const logout2 = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie), origin: 'https://app.example.test', 'x-csrf-token': csrfToken },
    });
    assert.equal(logout2.statusCode, 204);

    // The session is dead for every product surface.
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader(cookie) } });
    assert.equal(me.statusCode, 401);
    const sessionAfter = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: cookieHeader(cookie) } });
    assert.deepEqual(sessionAfter.json(), { authenticated: false });

    // Direct authority calls agree.
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('GET /api/v1/auth/sessions lists both devices; POST revoke of B leaves A', async () => {
    const { app, world, authority } = createAppHarness();
    apps.push(app);
    const first = seedUsableSession(world);
    seedBaSession(world, { id: 'ba-session-2', userId: 'ba-user-1', token: TOKEN_2 });
    seedMetadata(world, {
      authSessionId: 'ba-session-2',
      sessionTokenHash: browserSessionTokenHash(TOKEN_2),
      accountId: 'acct-1',
      idleExpiresAt: new Date(world.now.getTime() + 86_400_000),
      absoluteExpiresAt: new Date(world.now.getTime() + 30 * 86_400_000),
      securityEpoch: 0n,
      csrfTokenHash: browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(TOKEN_2)),
      predecessorSessionId: null,
      lastSeenAt: new Date(world.now.getTime() - 1_000),
      revokedAt: null,
      createdAt: new Date(world.now.getTime() - 1_000),
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(first.cookie) },
    });
    assert.equal(listed.statusCode, 200);
    const listedBody = listed.json() as {
      sessions: Array<{ id: string; createdAt: string; updatedAt: string; current: boolean }>;
    };
    assert.equal(listedBody.sessions.length, 2);
    assert.equal(listedBody.sessions.find((item) => item.id === 'ba-session-1')?.current, true);
    assert.equal(listedBody.sessions.find((item) => item.id === 'ba-session-2')?.current, false);
    assert.equal(JSON.stringify(listedBody).includes('token'), false, 'R9: list JSON must not include token');

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(first.cookie) },
    });
    const csrfToken = (sessionResponse.json() as { csrfToken: string }).csrfToken;

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers: { cookie: cookieHeader(first.cookie), origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: { sessionId: 'ba-session-2' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((noCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const revoked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers: {
        cookie: cookieHeader(first.cookie),
        origin: 'https://app.example.test',
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      payload: { sessionId: 'ba-session-2' },
    });
    assert.equal(revoked.statusCode, 200);
    assert.deepEqual(revoked.json(), { status: true });
    assert.equal(world.accounts.get('acct-1')?.securityEpoch, 0n);

    assert.ok(await authority.authenticate({ cookie: cookieHeader(first.cookie) }));
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookieValue(TOKEN_2)) }), null);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sessions/revoke',
      headers: {
        cookie: cookieHeader(first.cookie),
        origin: 'https://app.example.test',
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      payload: { sessionId: 'unknown-session-id' },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal((missing.json() as { error: { code: string } }).error.code, 'resource_not_found');
  });

  test('GET /api/v1/auth/sessions does not touch last_seen when a touch:true path would', async () => {
    const lastSeenAt = new Date('2026-07-22T11:58:00.000Z');
    const { app, world, identityState } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world, { lastSeenAt });
    seedIdentityProfile(identityState, 'acct-1', 'Profile One');
    const before = world.metadataById.get('ba-session-1')!.lastSeenAt.getTime();
    assert.equal(before, lastSeenAt.getTime());
    assert.ok(world.now.getTime() - before >= 60_000);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(world.touchCalls, 0);
    assert.equal(world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), before);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(world.touchCalls, 1);
    assert.equal(world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), world.now.getTime());
  });

  test('GET /api/v1/session does not touch last_seen when a touch:true path would', async () => {
    const lastSeenAt = new Date('2026-07-22T11:58:00.000Z');
    const { app, world, identityState } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world, { lastSeenAt });
    seedIdentityProfile(identityState, 'acct-1', 'Profile One');
    const before = world.metadataById.get('ba-session-1')!.lastSeenAt.getTime();
    assert.equal(before, lastSeenAt.getTime());
    assert.ok(world.now.getTime() - before >= SESSION_TOUCH_MIN_INTERVAL_MS);

    const boot = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(boot.statusCode, 200, boot.body);
    assert.equal((boot.json() as { authenticated: boolean }).authenticated, true);
    assert.equal(world.touchCalls, 0);
    assert.equal(world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), before);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(world.touchCalls, 1);
    assert.equal(world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), world.now.getTime());
  });

  test('non-heartbeat GET past idle TTL is unusable; GET /me after touchMinInterval slides idle', async () => {
    const expiredHarness = createAppHarness();
    apps.push(expiredHarness.app);
    const idlePast = new Date(expiredHarness.world.now.getTime() - 1_000);
    const { cookie: expiredCookie } = seedUsableSession(expiredHarness.world, {
      idleExpiresAt: idlePast,
      lastSeenAt: new Date(expiredHarness.world.now.getTime() - SESSION_IDLE_TTL_MS),
    });
    seedIdentityProfile(expiredHarness.identityState, 'acct-1', 'Profile One');
    const expiredList = await expiredHarness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(expiredCookie) },
    });
    assert.equal(expiredList.statusCode, 401, 'sessions GET past idle TTL must fail closed');
    const expiredMe = await expiredHarness.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(expiredCookie) },
    });
    assert.equal(expiredMe.statusCode, 401);

    const liveHarness = createAppHarness();
    apps.push(liveHarness.app);
    const lastSeenAt = new Date(liveHarness.world.now.getTime() - SESSION_TOUCH_MIN_INTERVAL_MS);
    const idleExpiresAt = new Date(liveHarness.world.now.getTime() + SESSION_IDLE_TTL_MS);
    const { cookie } = seedUsableSession(liveHarness.world, { lastSeenAt, idleExpiresAt });
    seedIdentityProfile(liveHarness.identityState, 'acct-1', 'Profile One');
    const listed = await liveHarness.app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(liveHarness.world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), lastSeenAt.getTime());
    assert.equal(liveHarness.world.metadataById.get('ba-session-1')!.idleExpiresAt.getTime(), idleExpiresAt.getTime());

    const me = await liveHarness.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(cookie) },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(liveHarness.world.metadataById.get('ba-session-1')!.lastSeenAt.getTime(), liveHarness.world.now.getTime());
    assert.equal(
      liveHarness.world.metadataById.get('ba-session-1')!.idleExpiresAt.getTime(),
      liveHarness.world.now.getTime() + SESSION_IDLE_TTL_MS,
    );
  });

  test('GET /api/v1/auth/sessions returns at most 50 newest sessions', async () => {
    const { app, world } = createAppHarness();
    apps.push(app);
    const first = seedUsableSession(world);
    const extras = seedExtraLiveSessions(world, 50);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { cookie: cookieHeader(first.cookie) },
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json() as {
      sessions: Array<{ id: string; createdAt: string; updatedAt: string; current: boolean }>;
    };
    assert.equal(body.sessions.length, BROWSER_SESSION_LIVE_CAP);
    assert.equal(body.sessions[0]?.id, 'ba-session-1');
    assert.equal(body.sessions[0]?.current, true);
    assert.equal(body.sessions.some((item) => item.id === extras[extras.length - 1]), false);
  });

  test('a revoked BA session fails every product route (401) and bootstrap stays honest', async () => {
    const { app, world, authority } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world);

    // Revoke the BA session row directly (as BA sign-out / expiry would).
    world.baSessions.delete(TOKEN_1);
    world.tokenBySessionId.delete('ba-session-1');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader(cookie) } });
    assert.equal(me.statusCode, 401);
    assert.equal((me.json() as { error: { code: string } }).error.code, 'authentication_required');
    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: cookieHeader(cookie) } });
    assert.deepEqual(session.json(), { authenticated: false });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
  });

  test('duplicate cookies and malformed encoding are rejected by the real admission before handlers', async () => {
    const { app, world } = createAppHarness();
    apps.push(app);
    const { cookie } = seedUsableSession(world);
    const duplicate = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${cookieHeader(cookie)}; ${cookieHeader(cookieValue(TOKEN_2))}` },
    });
    assert.equal(duplicate.statusCode, 400);
    assert.equal((duplicate.json() as { error: { code: string } }).error.code, 'invalid_request');

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${BROWSER_SESSION_COOKIE_NAME}=%zz` },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { error: { code: string } }).error.code, 'invalid_request');
  });

  test('requireSessionActor routes through the authority when injected', async () => {
    const { world, authority } = createMemoryHarness();
    const { cookie } = seedUsableSession(world);
    let legacyUowCalled = false;
    const legacyUnitOfWork: IdentityUnitOfWork = {
      execute: async () => {
        legacyUowCalled = true;
        throw new Error('legacy identity work must not run when the authority is injected');
      },
    };
    const request = {
      headers: { cookie: cookieHeader(cookie) },
      server: { browserSessionAuthority: authority },
    } as unknown as FastifyRequest;

    const actor = await requireSessionActor(request, legacyUnitOfWork, { touch: false });
    assert.equal(actor.account.id, 'acct-1');
    assert.equal(actor.session.id, 'ba-session-1');
    assert.equal(legacyUowCalled, false);

    // Without a cookie the authority path fails closed before the legacy UoW.
    await assert.rejects(
      () => requireSessionActor(
        { headers: {}, server: { browserSessionAuthority: authority } } as unknown as FastifyRequest,
        legacyUnitOfWork,
        { touch: false },
      ),
      (error: unknown) => {
        // requireSessionActor maps authority failures to the product 401
        // (ProductHttpError exposes the code as `productCode`).
        assert.equal((error as { productCode?: string }).productCode, 'authentication_required');
        return true;
      },
    );
    assert.equal(legacyUowCalled, false);
  });
});
