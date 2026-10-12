/**
 * External-backend mode for the MV3 product-stack fixtures.
 *
 * Set KNOWN_E2E_BACKEND_ORIGIN to an exact origin (no path) to skip the
 * in-process Fastify/Postgres stack. The extension build stays pinned; this
 * module writes dist/production/e2e-origin.json and loadConfig retargets that
 * pin through resolveRuntimeConfig. Plain HTTP cannot be written into
 * generated-config.json: parseBuildConfig rejects it.
 *
 * Precondition: create the fixture user with the server CLI before Playwright.
 * The extension signs in as p3-27-extension@example.test with password
 * p3-27-extension-password-e3 (same values as extension-auth.ts). On a
 * disposable colp-server instance, create this fixture as the FIRST owner:
 *
 *   printf '%s\n' 'p3-27-extension-password-e3' 'p3-27-extension-password-e3' \
 *     | colp-server create-user --username i2fixture --email p3-27-extension@example.test
 *
 * An existing single-owner instance cannot add this fixture. Use
 * mv3-colp-server-sync.spec.ts with COLP_I2_EMAIL/COLP_I2_PASSWORD there.
 * This module does not invoke the CLI. When sign-up is still open it creates
 * that same user through POST /api/v1/auth/sign-up/email, confirms the mailbox
 * when the test mailbox route is enabled, and creates the library through
 * POST /api/v1/collections.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';
import type { CanonicalFixture, IssuerMode, PushFault, RealStack } from './real-stack.js';
// @ts-expect-error The e2e harness reuses the backend's pinned PostgreSQL runtime.
import pg from '../../server/node_modules/pg/lib/index.js';

const FIXTURE_EMAIL = 'p3-27-extension@example.test';
const FIXTURE_PASSWORD = 'p3-27-extension-password-e3';
const FIXTURE_NAME = 'P3-27 Extension Fixture';
const DIST = resolve(import.meta.dirname, '../dist/production');
const MANIFEST_PATH = resolve(DIST, 'manifest.json');
const MANIFEST_BACKUP_PATH = resolve(DIST, 'manifest.host-backup.json');
const ORIGIN_PATH = resolve(DIST, 'e2e-origin.json');
const FAULT_PATH = resolve(DIST, 'e2e-fault.json');
const GENERATED_CONFIG_PATH = resolve(DIST, 'generated-config.json');

let activeCollectionId = FIXTURE_COLLECTION_ID;

export function externalBackendOrigin(): string | undefined {
  const raw = process.env.KNOWN_E2E_BACKEND_ORIGIN?.trim();
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('KNOWN_E2E_BACKEND_ORIGIN must be an exact origin'); }
  if (url.origin !== raw || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('KNOWN_E2E_BACKEND_ORIGIN must be an exact origin');
  }
  return url.origin;
}

export function fixtureCollectionId(): string {
  return activeCollectionId;
}

export function pointExtensionBuildConfig(origin: string): void {
  // Product-stack mounts are synchronous. Seeding still goes through the server API.
  void rewriteExtensionBuild(origin).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
  void ensureExternalSeed(origin).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
}

/** In-process route mounts stop here. Seeding is ensureExternalSeed. */
export function skippedInProcessProductStack(name: string): never {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => {
        throw new Error(`${name}: in-process routes are skipped while KNOWN_E2E_BACKEND_ORIGIN is set`);
      };
    },
  }) as never;
}

export async function clearExternalBuildPointing(): Promise<void> {
  activeCollectionId = FIXTURE_COLLECTION_ID;
  await rm(ORIGIN_PATH, { force: true });
  await rm(FAULT_PATH, { force: true });
  const backup = await readFile(MANIFEST_BACKUP_PATH, 'utf8').catch(() => undefined);
  if (backup !== undefined) {
    await writeFile(MANIFEST_PATH, backup);
    await rm(MANIFEST_BACKUP_PATH, { force: true });
  }
}

export async function startExternalRealStack(origin: string): Promise<RealStack> {
  // Production Better Auth has its own short sign-in budget, independent of
  // AUTH_RATE_LIMIT_MAX. Let the operator pace fixture seeding before UI login.
  const cooldown = Number(process.env.KNOWN_E2E_AUTH_COOLDOWN_MS ?? '0');
  if (!Number.isSafeInteger(cooldown) || cooldown < 0 || cooldown > 60_000) {
    throw new Error('KNOWN_E2E_AUTH_COOLDOWN_MS must be an integer from 0 to 60000');
  }
  await rewriteExtensionBuild(origin);
  const seed = await ensureExternalSeed(origin);
  if (cooldown > 0) await new Promise(resolveCooldown => setTimeout(resolveCooldown, cooldown));
  activeCollectionId = seed.collectionId;
  const databaseUrl = await databaseUrlForOrigin(origin);
  const pool = openPool(databaseUrl, 2);
  await installSignOutCounter(pool);
  const baseline = await snapshot(pool, seed.replicaId);
  let mode: IssuerMode = 'normal';
  let closed = false;

  function writeFault(next: IssuerMode | 'sync-offline'): void {
    writeFileSync(FAULT_PATH, `${JSON.stringify({ mode: next })}\n`);
  }

  return {
    browserHostResolverRules: 'MAP e2e.invalid 127.0.0.1',
    extensionBinding: seed.binding,
    extensionBindings: seed.bindings,
    authUserId: seed.authUserId,
    collectionId: seed.collectionId,
    serverOrigin: origin,
    setMode(value) { mode = value; writeFault(value); },
    setSyncOffline(offline) { writeFault(offline ? 'sync-offline' : mode); },
    async setFixtureCollectionUnavailable() { unsupported('setFixtureCollectionUnavailable'); },
    async observations() {
      const now = await snapshot(pool, seed.replicaId);
      const deletedSessions = Math.max(0, now.signOuts - baseline.signOuts);
      // Cross-site sign-out often omits the SameSite=Lax cookie, so the auth row survives.
      // Retire still runs. Count that logout when nothing was deleted.
      const loggedOut = baseline.replicaStatus !== 'retired' && now.replicaStatus === 'retired';
      return {
        revokeCount: deletedSessions > 0 ? deletedSessions : (loggedOut ? 1 : 0),
        syncOfflineBlockedRequests: 0,
        sessions: Math.max(0, now.sessions - baseline.sessions),
        receipts: Math.max(0, now.receipts - baseline.receipts),
        replicaStatus: now.replicaStatus,
        serverMutationCount: now.mutations,
        pushRequestDigests: [],
        pushRequests: [],
        pushResponses: [],
        pullResponses: [],
        sequenceReceipts: [],
        canonicalNodes: [],
        canonicalSiblingRows: [],
        canonicalSiblingOrders: {},
        pushErrors: [],
        authMailboxEntries: [],
      };
    },
    async canonicalSiblingOrder() { unsupported('canonicalSiblingOrder'); },
    async canonicalBookmarkExtensions() { unsupported('canonicalBookmarkExtensions'); },
    async setFaviconPolicyForFixture() { unsupported('setFaviconPolicyForFixture'); },
    async revokeCurrentCredential() {
      await pool.query(
        `update known_auth_session_metadata set revoked_at = current_timestamp
         where account_id = $1 and revoked_at is null`,
        [seed.accountId],
      );
      await pool.query(
        `update auth_sessions set "expiresAt" = current_timestamp - interval '1 second' where "userId" = $1`,
        [seed.authUserId],
      );
    },
    setPushFault(_fault: PushFault) { /* The external server does not inject push faults. */ },
    setEffectPageRateLimitPages() { /* The external server does not inject effect-page faults. */ },
    async seedPagedSubtree() { unsupported('seedPagedSubtree'); },
    async forceFixtureReplicaRecovery(): Promise<void> { unsupported('forceFixtureReplicaRecovery'); },
    async seedCanonicalFixture(): Promise<CanonicalFixture> { unsupported('seedCanonicalFixture'); },
    async concurrentlyUpdateCanonicalBookmark() { unsupported('concurrentlyUpdateCanonicalBookmark'); },
    async commitAfterDisconnect() { unsupported('commitAfterDisconnect'); },
    async restorePushResponses() { unsupported('restorePushResponses'); },
    async listDeletedCanonicalNodes() { unsupported('listDeletedCanonicalNodes'); },
    async restoreDeletedNode() { unsupported('restoreDeletedNode'); },
    async listProductTrash() { unsupported('listProductTrash'); },
    async restoreProductTrashBatch() { unsupported('restoreProductTrashBatch'); },
    async restoreProductTrashSubtree() { unsupported('restoreProductTrashSubtree'); },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end().catch(() => undefined);
      await clearExternalBuildPointing();
    },
  };
}

interface ExternalSeed {
  readonly authUserId: string;
  readonly accountId: string;
  readonly collectionId: string;
  readonly binding: RealStack['extensionBinding'];
  readonly bindings: RealStack['extensionBindings'];
  readonly replicaId: string;
}

async function ensureExternalSeed(origin: string): Promise<ExternalSeed> {
  const session = await ensureFixtureUser(origin);
  const collectionId = await createCollection(origin, session);
  const suffix = randomUUID().replaceAll('-', '');
  const binding = {
    replicaId: `replica-${suffix}`,
    browserProfileId: `profile-${suffix}`,
    generation: '1' as const,
  };
  const extra = (label: string) => ({
    replicaId: `replica-${suffix}-${label}`,
    browserProfileId: `profile-${suffix}-${label}`,
    generation: '1' as const,
  });
  await signOut(origin, session.cookie);
  return {
    authUserId: session.authUserId,
    accountId: session.accountId,
    collectionId,
    binding,
    bindings: [extra('a'), extra('b')],
    replicaId: binding.replicaId,
  };
}

interface FixtureSession {
  readonly cookie: string;
  readonly authUserId: string;
  readonly accountId: string;
}

async function ensureFixtureUser(origin: string): Promise<FixtureSession> {
  const signedIn = await trySignIn(origin);
  if (signedIn) return signedIn;
  const signUp = await postJson(origin, '/api/v1/auth/sign-up/email', {
    email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD, name: FIXTURE_NAME,
  });
  if (signUp.status === 403 || signUp.code === 'registration_closed') {
    throw new Error(
      'fixture user is missing and registration is closed. '
      + 'Create it with the server CLI first: colp-server create-user --username i2fixture '
      + '--email p3-27-extension@example.test',
    );
  }
  if (signUp.status !== 200 && signUp.code !== 'invalid_credentials') {
    throw new Error(`fixture sign-up failed (${signUp.status} ${signUp.code ?? 'no_code'})`);
  }
  await verifyFixtureEmail(origin);
  const after = await trySignIn(origin);
  if (!after) throw new Error('fixture sign-in failed after sign-up. Create the user with the server CLI first.');
  return after;
}

async function trySignIn(origin: string, allowVerify = true): Promise<FixtureSession | undefined> {
  const result = await postJson(origin, '/api/v1/auth/sign-in/email', {
    email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD,
  });
  if (allowVerify && (result.code === 'verification_required' || result.code === 'EMAIL_NOT_VERIFIED')) {
    await verifyFixtureEmail(origin);
    return trySignIn(origin, false);
  }
  if (result.status !== 200) return undefined;
  const cookie = sessionCookie(result.setCookie);
  if (!cookie) throw new Error('fixture sign-in did not set a session cookie');
  const authUserId = userIdFrom(result.body) ?? await authUserIdFromDatabase(origin);
  const accountId = await accountIdForUser(origin, authUserId);
  return { cookie, authUserId, accountId };
}

async function verifyFixtureEmail(origin: string): Promise<void> {
  const token = await mailboxToken(origin);
  if (!token) {
    await markEmailVerified(origin);
    return;
  }
  const url = new URL('/api/v1/auth/verify-email', origin);
  url.searchParams.set('token', token);
  const response = await fetch(url, { redirect: 'manual', headers: { origin } });
  if (response.status >= 400) await markEmailVerified(origin);
}

async function mailboxToken(origin: string): Promise<string | undefined> {
  const bearer = await serverEnv(origin, 'KNOWN_AUTH_MAILBOX_HTTP_TOKEN');
  if (!bearer) return undefined;
  const response = await fetch(`${origin}/__test__/auth-mailbox`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { entries?: ReadonlyArray<{ url?: string | null; to?: string }> };
  const entry = [...(body.entries ?? [])].reverse().find((item) => item.to === FIXTURE_EMAIL && item.url);
  if (!entry?.url) return undefined;
  return new URL(entry.url).searchParams.get('token') ?? undefined;
}

async function createCollection(origin: string, session: FixtureSession): Promise<string> {
  const csrf = await csrfToken(origin, session.cookie);
  const response = await fetch(`${origin}/api/v1/collections`, {
    method: 'POST',
    headers: {
      origin,
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': csrf,
      'known-command-id': randomUUID(),
    },
    body: JSON.stringify({ kind: 'bookmarks', title: 'P3-27', summary: 'External e2e library' }),
  });
  const text = await response.text();
  if (response.status !== 201) throw new Error(`fixture collection create failed (${response.status})`);
  const body = JSON.parse(text) as { collection?: { id?: string } };
  const id = body.collection?.id;
  if (!id) throw new Error('fixture collection create returned no id');
  return id;
}

async function csrfToken(origin: string, cookie: string): Promise<string> {
  let last = 'no_response';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/session`, { headers: { origin, cookie, accept: 'application/json' } });
    const body = await response.json() as { csrfToken?: string; authenticated?: boolean };
    if (body.csrfToken) return body.csrfToken;
    last = `${response.status} authenticated=${String(body.authenticated)}`;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`fixture session did not return a csrf token (${last})`);
}

async function signOut(origin: string, cookie: string): Promise<void> {
  await fetch(`${origin}/api/v1/auth/sign-out`, { method: 'POST', headers: { origin, cookie } });
}

async function postJson(origin: string, path: string, body: unknown): Promise<{
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;
  readonly setCookie: readonly string[];
}> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  const record = parsed && typeof parsed === 'object' ? parsed as { code?: unknown } : undefined;
  return {
    status: response.status,
    ...(typeof record?.code === 'string' ? { code: record.code } : {}),
    body: parsed,
    setCookie: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
  };
}

function sessionCookie(headers: readonly string[]): string | undefined {
  for (const header of headers) {
    const match = /^(?:__Host-known_session|known_session)=([^;]*)/u.exec(header);
    if (!match?.[1]) continue;
    return `${header.startsWith('__Host-') ? '__Host-known_session' : 'known_session'}=${match[1]}`;
  }
  return undefined;
}

function userIdFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const user = (body as { user?: { id?: unknown } }).user;
  return user && typeof user.id === 'string' ? user.id : undefined;
}

async function rewriteExtensionBuild(origin: string): Promise<void> {
  const raw = await readFile(GENERATED_CONFIG_PATH, 'utf8').catch(() => {
    throw new Error('external e2e needs dist/production from: npm run build -- --config config/e2e-fixture.json');
  });
  const config = JSON.parse(raw) as { deploymentId?: string };
  if (config.deploymentId !== 'e2e-fixture') {
    throw new Error('external e2e needs dist/production built with config/e2e-fixture.json');
  }
  const pattern = `${origin}/*`;
  const backup = await readFile(MANIFEST_BACKUP_PATH, 'utf8').catch(() => undefined);
  if (backup === undefined) await writeFile(MANIFEST_BACKUP_PATH, await readFile(MANIFEST_PATH, 'utf8'));
  const manifest = JSON.parse(backup ?? await readFile(MANIFEST_PATH, 'utf8')) as { host_permissions?: string[] };
  const permissions = new Set(manifest.host_permissions ?? []);
  permissions.add(pattern);
  manifest.host_permissions = [...permissions];
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(ORIGIN_PATH, `${JSON.stringify({ origin })}\n`);
  await writeFile(FAULT_PATH, `${JSON.stringify({ mode: 'normal' })}\n`);
}

async function databaseUrlForOrigin(origin: string): Promise<string> {
  const fromEnv = process.env.KNOWN_E2E_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const port = Number(new URL(origin).port || (new URL(origin).protocol === 'https:' ? 443 : 80));
  let pid = await listenerPid(port);
  for (let hop = 0; pid && hop < 4; hop += 1) {
    const env = await processEnv(pid);
    const url = env.DATABASE_URL?.trim();
    if (url) return url;
    const parent = Number(env._PPID ?? 0);
    pid = parent > 1 ? parent : undefined;
  }
  throw new Error('external e2e could not find DATABASE_URL for the backend. Set KNOWN_E2E_DATABASE_URL.');
}

async function listenerPid(port: number): Promise<number | undefined> {
  const { stdout } = await promisify(execFile)('ss', ['-ltnp', `sport = :${port}`]).catch(() => ({ stdout: '' }));
  const match = /pid=(\d+)/u.exec(stdout);
  return match ? Number(match[1]) : undefined;
}

async function processEnv(pid: number): Promise<Record<string, string>> {
  const raw = await readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0));
  const env: Record<string, string> = {};
  for (const entry of raw.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const parent = /^PPid:\s+(\d+)/mu.exec(status);
  if (parent) env._PPID = parent[1]!;
  return env;
}

async function serverEnv(origin: string, name: string): Promise<string | undefined> {
  if (process.env[name]?.trim()) return process.env[name]?.trim();
  const port = Number(new URL(origin).port || 80);
  const pid = await listenerPid(port);
  if (!pid) return undefined;
  return (await processEnv(pid))[name]?.trim() || undefined;
}

async function authUserIdFromDatabase(origin: string): Promise<string> {
  const pool = openPool(await databaseUrlForOrigin(origin), 1);
  try {
    const result = await pool.query('select id from auth_users where email = $1', [FIXTURE_EMAIL]);
    const id = result.rows[0]?.id;
    if (typeof id !== 'string') throw new Error('fixture auth user id is missing');
    return id;
  } finally { await pool.end(); }
}

async function accountIdForUser(origin: string, authUserId: string): Promise<string> {
  const pool = openPool(await databaseUrlForOrigin(origin), 1);
  try {
    const mapped = await pool.query(
      'select account_id from auth_user_account_map where auth_user_id = $1',
      [authUserId],
    );
    const id = mapped.rows[0]?.account_id;
    if (typeof id === 'string') return id;
    throw new Error('fixture account mapping is missing');
  } finally { await pool.end(); }
}

function openPool(connectionString: string, max: number): SqlPool {
  const pool = new pg.Pool({ connectionString, max });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]),
    end: () => pool.end(),
  };
}

async function markEmailVerified(origin: string): Promise<void> {
  const pool = openPool(await databaseUrlForOrigin(origin), 1);
  try {
    await pool.query('update auth_users set "emailVerified" = true where email = $1', [FIXTURE_EMAIL]);
  } finally { await pool.end(); }
}

interface SqlPool {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

async function installSignOutCounter(pool: SqlPool): Promise<void> {
  await pool.query(`create table if not exists e2e_external_signouts (
    id bigint generated always as identity primary key
  )`);
  await pool.query(`create or replace function e2e_external_signout_log() returns trigger language plpgsql as $$
    begin insert into e2e_external_signouts default values; return old; end $$`);
  await pool.query('drop trigger if exists e2e_external_signout on auth_sessions');
  await pool.query(`create trigger e2e_external_signout after delete on auth_sessions
    for each row execute function e2e_external_signout_log()`);
}

async function snapshot(pool: SqlPool, replicaId: string): Promise<{
  readonly sessions: number; readonly receipts: number; readonly signOuts: number;
  readonly replicaStatus: string | null; readonly mutations: number;
}> {
  const count = async (sql: string, params: readonly unknown[] = []) => {
    const result = await pool.query(sql, params as unknown[]);
    return Number(result.rows[0]?.count ?? 0);
  };
  const replica = await pool.query('select status from sync_replicas where replica_id = $1', [replicaId]);
  return {
    sessions: await count('select count(*)::int as count from sync_sessions'),
    receipts: await count('select count(*)::int as count from sync_session_idempotency_receipts'),
    signOuts: await count('select count(*)::int as count from e2e_external_signouts'),
    replicaStatus: replica.rows[0]?.status == null ? null : String(replica.rows[0].status),
    mutations: await count('select count(*)::int as count from nodes where not is_root'),
  };
}

function unsupported(method: string): never {
  throw new Error(`${method} is not available against KNOWN_E2E_BACKEND_ORIGIN`);
}
