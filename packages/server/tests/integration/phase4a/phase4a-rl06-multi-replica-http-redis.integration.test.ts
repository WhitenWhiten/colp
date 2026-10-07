/**
 * P4A-RL06 multi-replica admission end to end (plan §8 RL06, §11 matrix:
 * real PostgreSQL via `scripts/with-postgres.mjs` + real Redis via
 * Testcontainers `redis:7-alpine` + HTTP; RL06 does NOT require real R2, so
 * the object store is the production R2 adapter over the local object server
 * stub, with the shared request log as the R2 side-effect counter). The
 * Redis-outage/recovery scenario lives in the sibling suite
 * `phase4a-rl06-outage-recovery-http-redis.integration.test.ts`.
 *
 * The suite starts TWO concurrent production API compositions (the RL04
 * `buildRl04App` pattern — the established "independent app instance" test
 * support), each with its OWN real ioredis client, its OWN in-process local
 * and emergency limiters and its OWN metrics/log sinks. They share ONLY
 * PostgreSQL and the Redis quota namespace (same key prefix + HMAC secret =
 * one shared quota identity). This satisfies the RL06 evidence purposes the
 * plan demands (plan §8 RL06, §4.1.9/§4.2.9): at least two API instances with
 * fully independent in-process state, each with its own Redis client, no
 * shared memory objects and no sticky session. A real subprocess API cannot
 * run here: the production attachments profile parses
 * `ATTACHMENTS_R2_ENDPOINT` to the real account shape
 * (`https://<32-hex>.r2.cloudflarestorage.com`, plan §4.1.7/§11), so a
 * subprocess would need real R2 while §11 does not require real R2 for
 * RL06 — the subprocess-level proof arrives with real R2 in P11.
 * Independence of in-process state is proven, not assumed: the shadow
 * download test (T6) shows each instance's own local limiter admits its own
 * attempt while the shared Redis counter sees all attempts, and per-instance
 * EVALSHA counters prove every instance ran admission through its own
 * client.
 *
 * Anti-false-positive anchors (plan §4.1.9/§4.2.9):
 *  - the load client explicitly alternates instance addresses (A, B, A, B,
 *    ...) and per-instance served counters are asserted — all requests
 *    landing on one instance fails;
 *  - every instance proves it ran admission through its OWN Redis client
 *    (per-instance EVALSHA counters > 0) and the instances never share
 *    in-memory limiter state (a shadow-download test proves the per-instance
 *    local limiters are independent while the Redis counter is shared);
 *  - every rate-limited/exhausted assertion also proves ZERO expensive work:
 *    `upload_intents`/outbox row counts, the object-server request log and
 *    the per-instance download use-case counters all stay put;
 *  - 429 responses carry the real quota facts (Retry-After +
 *    RateLimit-Policy) and 503s never fabricate them (plan §4.1.10).
 *
 * Anti-false-negative anchors:
 *  - exact-count bursts wait for server-time window headroom first (plan
 *    §2.3: the window is floor-aligned to Redis server time) — polling,
 *    never a fixed sleep;
 *  - TTL/time assertions use loose ranges only.
 *
 * Container start/stop failures are environment failures — never a skip
 * (plan §4.2.6). Failure diagnostics keep fixed low-sensitivity text and
 * never record subjects, keys or secrets.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect as connectSocket } from 'node:net';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { FastifyInstance } from 'fastify';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createRedisAuthRateLimitStore,
  createRedisMcpRateLimitStore,
  createRedisSearchRateLimitStore,
  parseAuthRateLimitKey,
  parseMcpRateLimitKey,
  parseSearchRateLimitKey,
  type AuthRateLimiter,
  type McpRateLimiter,
  type SearchRateLimiter,
} from '../../../src/infrastructure/rate-limit/index.js';
import { makeP03Config } from '../../support/phase4a-p03-test-helpers.js';
import { p07Body } from '../../support/phase4a-p07-test-helpers.js';
import type { SearchQueryInput, SearchQueryResult } from '../../../src/modules/search/index.js';
import { rl04CountingClientFactory, type Rl04AppBundle, type Rl04ClientCounts } from '../../support/phase4a-rl04-test-helpers.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  alternate,
  buildRl06Instance,
  buildRl06Pair,
  countOutboxEvents,
  countUploadIntents,
  makeRl06RateLimitConfig,
  prepareStored,
  rl06Admit,
  rl06Complete,
  rl06Issue,
  rl06ProblemOf,
  rl06Status,
  startRl06SuiteEnv,
  waitForWindowHeadroom,
  type Rl06HttpResponse,
  type Rl06Pair,
  type Rl06SuiteEnv,
} from '../../support/phase4a-rl06-test-helpers.js';
import { createDeliveryRateLimiter } from '../../../src/modules/attachments/index.js';
import { parseAttachmentRateLimitKey, type AttachmentRateLimitConfig } from '../../../src/modules/attachments/index.js';
import { RL06_COLLECTION, RL06_COLLECTION_SCOPE } from '../../support/phase4a-rl06-test-helpers.js';

let env: Rl06SuiteEnv;
const usedPrefixes = new Set<string>();
const openBundles: Rl04AppBundle[] = [];

// ---------------------------------------------------------------------------
// FIX-M-001 auth rate-limit fixtures: minimal API instances sharing ONE Redis
// quota namespace (same key prefix + HMAC secret), each with its OWN auth
// store + Redis client. Only the auth limiter wiring is exercised here; the
// shared PostgreSQL/object-server fixtures of this suite stay untouched.
// ---------------------------------------------------------------------------

interface AuthTestBundle {
  /** Fixed instance label used only in low-sensitivity diagnostics. */
  readonly name: string;
  readonly app: FastifyInstance;
  readonly limiter: AuthRateLimiter;
  /** Per-instance Redis command counts of THIS instance's OWN client. */
  readonly counts: Rl04ClientCounts;
  /** HTTP requests actually delivered to THIS instance (alternation proof). */
  requests: number;
}

interface AuthTestPair {
  readonly a: AuthTestBundle;
  readonly b: AuthTestBundle;
}

const openAuthBundles: AuthTestBundle[] = [];

async function buildAuthInstance(
  name: string,
  prefix: string,
  keySecret: Buffer,
  maxRequests: number,
  windowMs: number,
): Promise<AuthTestBundle> {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_MAX: String(maxRequests),
    AUTH_RATE_LIMIT_WINDOW_MS: String(windowMs),
  });
  const counting = rl04CountingClientFactory();
  const limiter = createRedisAuthRateLimitStore({
    redisUrl: env.redisUrl,
    environment: 'test',
    keySecret,
    keyPrefix: prefix,
    maxRequests,
    windowMs,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3000,
    maxRetriesPerRequest: 1,
    createClient: counting.factory,
  });
  const app = buildApiApp({
    config,
    authRateLimiter: limiter,
    identityUnitOfWork: env.identityUnitOfWork,
  });
  // Readiness barrier (same convention as buildRl06Instance): the lazy
  // ioredis connection races the first command; admission must not start
  // until the shared store reports healthy, or the first requests would
  // fail closed on the connect window instead of proving the quota.
  await waitUntil(
    () => limiter.readiness().status === 'healthy',
    20_000,
    `auth rate-limit store ${name} ready`,
    25,
  );
  return { name, app, limiter, counts: counting.counts, requests: 0 };
}

/** Two concurrent instances sharing prefix + secret (ONE auth quota). */
async function buildAuthPair(
  prefix: string,
  keySecret: Buffer,
  maxRequests: number,
  windowMs: number,
): Promise<AuthTestPair> {
  const a = await buildAuthInstance('A-auth', prefix, keySecret, maxRequests, windowMs);
  const b = await buildAuthInstance('B-auth', prefix, keySecret, maxRequests, windowMs);
  usedPrefixes.add(prefix);
  openAuthBundles.push(a, b);
  return { a, b };
}

/** GET /api/v1/session against ONE named instance from a fixed client IP. */
async function authSession(instance: AuthTestBundle, ip: string): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({ method: 'GET', url: '/api/v1/session', remoteAddress: ip });
}

/** GET /api/v1/me against ONE named instance from a fixed client IP. */
async function authMe(instance: AuthTestBundle, ip: string): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({ method: 'GET', url: '/api/v1/me', remoteAddress: ip });
}

/** GET /health against ONE named instance. */
async function authHealth(instance: AuthTestBundle): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({ method: 'GET', url: '/health' });
}

// ---------------------------------------------------------------------------
// FIX-M-006 Search rate-limit fixtures: minimal API instances sharing ONE
// Redis quota namespace (same key prefix + HMAC secret), each with its OWN
// search store + Redis client, PLUS the trusted-ingress declaration so
// requests behind the nginx peer resolve the real client IP. Only the Search
// admission wiring is exercised; the canned query never touches PostgreSQL.
// ---------------------------------------------------------------------------

const SEARCH_NGINX_IMAGE = process.env.KNOWN_NGINX_IMAGE?.trim() || 'nginx:alpine';
const SEARCH_PROXY_PEER = '10.0.0.2';
const SEARCH_INGRESS_CIDR = '10.0.0.0/8';

interface SearchTestBundle {
  /** Fixed instance label used only in low-sensitivity diagnostics. */
  readonly name: string;
  readonly app: FastifyInstance;
  readonly limiter: SearchRateLimiter;
  /** Per-instance Redis command counts of THIS instance's OWN client. */
  readonly counts: Rl04ClientCounts;
  /** HTTP requests actually delivered to THIS instance (alternation proof). */
  requests: number;
}

interface SearchTestPair {
  readonly a: SearchTestBundle;
  readonly b: SearchTestBundle;
}

const openSearchBundles: SearchTestBundle[] = [];

/** Canned Search query: a valid projection for both principal kinds. */
function cannedSearchQuery(): { execute(input: SearchQueryInput): Promise<SearchQueryResult> } {
  return {
    execute: async (input) => ({
      normalizedQuery: input.query,
      types: input.types ?? ['collection', 'node', 'profile', 'annotation'],
      items: [{ resourceType: 'collection', resourceId: 'topology-collection', title: 'Topology',
        snippet: 'A bounded plain-text result.', rank: 0.5 }],
      page: { returnedCount: 1, hasMore: false, nextCursor: null },
      cache: input.principal.kind === 'anonymous'
        ? { class: 'shared-public', partition: 'anonymous-representation-partition' }
        : { class: 'private-no-store', partition: null },
      consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
    }),
  };
}

async function buildSearchInstance(
  name: string,
  prefix: string,
  keySecret: Buffer,
  anonymousMaxRequests: number,
  accountMaxRequests: number,
  windowMs: number,
  trustedIngress: string,
): Promise<SearchTestBundle> {
  const config = loadConfig({
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    TRUSTED_INGRESS: trustedIngress,
    SEARCH_ANON_RATE_LIMIT_MAX: String(anonymousMaxRequests),
    SEARCH_ACCOUNT_RATE_LIMIT_MAX: String(accountMaxRequests),
    SEARCH_RATE_LIMIT_WINDOW_MS: String(windowMs),
  });
  const counting = rl04CountingClientFactory();
  const limiter = createRedisSearchRateLimitStore({
    redisUrl: env.redisUrl,
    environment: 'test',
    keySecret,
    keyPrefix: prefix,
    anonymousMaxRequests,
    accountMaxRequests,
    windowMs,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3000,
    maxRetriesPerRequest: 1,
    createClient: counting.factory,
  });
  const app = buildApiApp({
    config,
    searchQuery: cannedSearchQuery(),
    searchRateLimiter: limiter,
  });
  // Readiness barrier (same convention as buildAuthInstance): the lazy
  // ioredis connection races the first command; admission must not start
  // until the shared store reports healthy.
  await waitUntil(
    () => limiter.readiness().status === 'healthy',
    20_000,
    `search rate-limit store ${name} ready`,
    25,
  );
  return { name, app, limiter, counts: counting.counts, requests: 0 };
}

/** Two concurrent instances sharing prefix + secret (ONE Search quota). */
async function buildSearchPair(
  prefix: string,
  keySecret: Buffer,
  anonymousMaxRequests: number,
  accountMaxRequests: number,
  windowMs: number,
  trustedIngress: string = SEARCH_INGRESS_CIDR,
): Promise<SearchTestPair> {
  const a = await buildSearchInstance('A-search', prefix, keySecret, anonymousMaxRequests, accountMaxRequests, windowMs, trustedIngress);
  const b = await buildSearchInstance('B-search', prefix, keySecret, anonymousMaxRequests, accountMaxRequests, windowMs, trustedIngress);
  usedPrefixes.add(prefix);
  openSearchBundles.push(a, b);
  return { a, b };
}

/** GET /api/v1/search through the trusted proxy peer (nginx hop) for ONE client IP. */
async function searchViaProxy(instance: SearchTestBundle, clientIp: string): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({
    method: 'GET',
    url: '/api/v1/search?q=topology',
    remoteAddress: SEARCH_PROXY_PEER,
    headers: { 'x-forwarded-for': clientIp },
  });
}

/** GET /api/v1/search DIRECTLY to the instance (no trusted proxy in front). */
async function searchDirect(instance: SearchTestBundle, peerIp: string, xff?: string): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({
    method: 'GET',
    url: '/api/v1/search?q=topology',
    remoteAddress: peerIp,
    ...(xff === undefined ? {} : { headers: { 'x-forwarded-for': xff } }),
  });
}

/** GET /health against ONE named instance. */
async function searchHealth(instance: SearchTestBundle): Promise<Rl06HttpResponse> {
  instance.requests += 1;
  return instance.app.inject({ method: 'GET', url: '/health' });
}

/** Raw HTTP/1.1 GET against a real socket (nginx container or direct API). */
async function rawSearchHttp(port: number, target: string,
  headers: Readonly<Record<string, string>> = {}): Promise<Rl06HttpResponse> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => socket.destroy(new Error('raw Search HTTP request timed out')), 5_000);
    socket.on('connect', () => {
      const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write([`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close',
        ...headerLines, '', ''].join('\r\n'), 'latin1');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timeout);
      const response = Buffer.concat(chunks).toString('utf8');
      const boundary = response.indexOf('\r\n\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1];
      if (!status || boundary < 0) { reject(new Error(`invalid raw HTTP response: ${response.slice(0, 120)}`)); return; }
      resolve({
        statusCode: Number(status),
        headers: Object.fromEntries(response.slice(0, boundary).split('\r\n').slice(1)
          .map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])),
        body: response.slice(boundary + 4),
      });
    });
  });
}

/** Wait until a TCP port accepts connections (nginx readiness, polling). */
async function waitForTcp(port: number, timeoutMs = 30_000): Promise<void> {
  await waitForCondition(async () => {
    const accepted = await new Promise<boolean>((resolve) => {
      const socket = connectSocket({ host: '127.0.0.1', port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.on('error', () => { clearTimeout(timer); resolve(false); });
    });
    return accepted;
  }, {
    timeoutMs,
    pollIntervalMs: 25,
    description: `TCP port ${port} to accept connections`,
  });
}

/**
 * Real nginx container (same XFF rewriting as devops/docker/nginx.conf)
 * proxying to TWO API replicas. The API instances trust the docker bridge
 * subnet (derived from the container IP) so the peer chain resolves; the
 * direct host loopback stays UNTRUSTED.
 *
 * The main nginx.conf is overridden with `worker_processes 1;`: the stock
 * image uses `worker_processes auto`, whose round-robin upstream state has
 * a per-worker initial burst on the FIRST peer (all N workers start at the
 * same rotation slot), so how many requests the second replica receives
 * before alternation starts depends on the host CPU count. Pinning one
 * worker makes the alternation strictly deterministic (A, B, A, B, …) on
 * every machine, so the per-instance participation assertions below are
 * stable; the http-level directives (XFF rewriting) mirror the repo config.
 */
async function startSearchNginx(portA: number, portB: number): Promise<StartedTestContainer> {
  // Main-context override: single worker => deterministic round-robin.
  const mainConf = `worker_processes 1;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  include /etc/nginx/conf.d/*.conf;
}
`;
  // conf.d/default.conf is INCLUDED inside the http block of the main
  // nginx.conf, so only http-level directives are valid here (upstream +
  // server). The XFF rewriting mirrors devops/docker/nginx.conf.
  const conf = `upstream known_api {
    server host.docker.internal:${portA};
    server host.docker.internal:${portB};
  }
  server {
    listen 80;
    server_name _;
    location /api/ {
      proxy_pass http://known_api;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 5s;
      proxy_send_timeout 5s;
    }
    location / { return 404; }
  }
`;
  let container: StartedTestContainer;
  try {
    container = await new GenericContainer(SEARCH_NGINX_IMAGE)
      .withExposedPorts(80)
      .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
      .withCopyContentToContainer([
        { content: mainConf, target: '/etc/nginx/nginx.conf' },
        { content: conf, target: '/etc/nginx/conf.d/default.conf' },
      ])
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `FIX-M-006 fail-closed: could not start the nginx topology container (image ${SEARCH_NGINX_IMAGE}). ` +
        `The Search topology suite requires Docker/Testcontainers: ${detail}`,
    );
  }
  return container;
}

// ---------------------------------------------------------------------------
// FIX-M-018 MCP rate-limit fixtures: two independent limiter compositions
// sharing ONE Redis quota namespace (same key prefix + HMAC secret), each
// with its OWN Redis client. The unified port owns three named policies
// (request / approval / commit-distinct-plan) whose keys are HMACs over
// stable principal/client/binding facts; the three budgets never overlap.
// ---------------------------------------------------------------------------

const MCP_AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const MCP_APPROVAL_LIST_FAMILY = '/api/v1/mcp/approvals';
const MCP_APPROVAL_DECISION_FAMILY = '/api/v1/mcp/approvals/:planId/decision';

interface McpTestBudgets {
  readonly request: { readonly maxRequests: number; readonly windowMs: number };
  readonly approval: { readonly maxRequests: number; readonly windowMs: number };
  readonly commit: { readonly maxPlans: number; readonly windowMs: number };
}

interface McpTestBundle {
  /** Fixed instance label used only in low-sensitivity diagnostics. */
  readonly name: string;
  readonly limiter: McpRateLimiter;
  /** Per-instance Redis command counts of THIS instance's OWN client. */
  readonly counts: Rl04ClientCounts;
}

interface McpTestPair {
  readonly a: McpTestBundle;
  readonly b: McpTestBundle;
}

const openMcpBundles: McpTestBundle[] = [];

/** Stable authenticated binding facts (same shape the request/commit routes build). */
function mcpBindingFacts(
  principal: string,
  client = 'client-1',
  credential = 'credential-1',
  epoch = 'epoch-1',
): string {
  return ['authenticated', principal, client, credential, MCP_AUDIENCE, epoch].join(':');
}

/** Stable approval facts: sealed route family + principal (mirrors the route keys). */
function mcpApprovalFacts(family: string, principal: string): string {
  return `${family}:principal:${principal}`;
}

function mcpBudgets(requestMax: number, approvalMax: number, commitMax: number): McpTestBudgets {
  return {
    request: { maxRequests: requestMax, windowMs: 60_000 },
    approval: { maxRequests: approvalMax, windowMs: 60_000 },
    commit: { maxPlans: commitMax, windowMs: 60_000 },
  };
}

async function buildMcpInstance(
  name: string,
  prefix: string,
  keySecret: Buffer,
  budgets: McpTestBudgets,
): Promise<McpTestBundle> {
  const counting = rl04CountingClientFactory();
  const limiter = createRedisMcpRateLimitStore({
    redisUrl: env.redisUrl,
    environment: 'test',
    keySecret,
    keyPrefix: prefix,
    request: budgets.request,
    approval: budgets.approval,
    commit: budgets.commit,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3000,
    maxRetriesPerRequest: 1,
    createClient: counting.factory,
  });
  // Readiness barrier (same convention as the auth/search instances): the
  // lazy ioredis connection races the first command; admission must not
  // start until the shared store reports healthy, or the first checks would
  // fail closed on the connect window instead of proving the quota.
  await waitUntil(
    () => limiter.readiness().status === 'healthy',
    20_000,
    `mcp rate-limit store ${name} ready`,
    25,
  );
  return { name, limiter, counts: counting.counts };
}

/** Two concurrent instances sharing prefix + secret (ONE quota per policy). */
async function buildMcpPair(
  prefix: string,
  keySecret: Buffer,
  budgets: McpTestBudgets,
): Promise<McpTestPair> {
  const a = await buildMcpInstance('A-mcp', prefix, keySecret, budgets);
  const b = await buildMcpInstance('B-mcp', prefix, keySecret, budgets);
  usedPrefixes.add(prefix);
  openMcpBundles.push(a, b);
  return { a, b };
}

interface NewPairExtras {
  readonly modeB?: AttachmentRateLimitConfig['mode'];
  readonly localLimiterA?: ReturnType<typeof createDeliveryRateLimiter>;
  readonly localLimiterB?: ReturnType<typeof createDeliveryRateLimiter>;
  readonly keySecret?: Buffer;
}

/** A pair of concurrent instances sharing prefix + HMAC secret (one quota). */
async function newPair(
  prefix: string,
  overrides: Partial<AttachmentRateLimitConfig> = {},
  extras: NewPairExtras = {},
): Promise<Rl06Pair> {
  const pair = await buildRl06Pair({
    runtime: env.isolated,
    databaseUrl: env.isolated.databaseUrl,
    identityUnitOfWork: env.identityUnitOfWork,
    browserSessionAuthority: env.factory.authority,
    objectServerUrl: env.objectServer.url,
    attachmentsConfig: makeP03Config(),
    rateLimitConfig: makeRl06RateLimitConfig(env.redisUrl, prefix, overrides),
    keySecret: extras.keySecret ?? Buffer.from(`rl06-secret-${randomUUID()}`, 'utf8'),
    ...(extras.modeB === undefined ? {} : { modeB: extras.modeB }),
    ...(extras.localLimiterA === undefined ? {} : { localLimiterA: extras.localLimiterA }),
    ...(extras.localLimiterB === undefined ? {} : { localLimiterB: extras.localLimiterB }),
  });
  openBundles.push(pair.a.bundle, pair.b.bundle);
  usedPrefixes.add(prefix);
  return pair;
}

describeWithPostgres('P4A-RL06 multi-replica admission end to end', () => {
  beforeAll(async () => {
    env = await startRl06SuiteEnv();
  }, 240_000);

  afterEach(async () => {
    // Exact-key cleanup for every run prefix used by this suite (no
    // FLUSHALL/FLUSHDB; KEYS is a test-only cleanup scan, never application).
    for (const prefix of usedPrefixes) {
      const keys = await env.raw.keys(`${prefix}:*`);
      for (const key of keys) {
        try { await env.raw.del(key); } catch { /* best-effort */ }
      }
    }
    usedPrefixes.clear();
    const open = openBundles.splice(0, openBundles.length);
    await Promise.all(open.map((bundle) => bundle.close().catch(() => undefined)));
    const authOpen = openAuthBundles.splice(0, openAuthBundles.length);
    await Promise.all(authOpen.map((bundle) => Promise.all([
      bundle.app.close().catch(() => undefined),
      bundle.limiter.close().catch(() => undefined),
    ])));
    const searchOpen = openSearchBundles.splice(0, openSearchBundles.length);
    await Promise.all(searchOpen.map((bundle) => Promise.all([
      bundle.app.close().catch(() => undefined),
      bundle.limiter.close().catch(() => undefined),
    ])));
    const mcpOpen = openMcpBundles.splice(0, openMcpBundles.length);
    await Promise.all(mcpOpen.map((bundle) => bundle.limiter.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await env?.dropSchema(); } catch (error) { errors.push(error); }
    try { await env?.stop(); } catch (error) { errors.push(error); }
    if (errors.length > 0) {
      throw new Error(`P4A-RL06 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('two instances share ONE issue budget with explicit alternation; denials create zero DB/R2 work', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    await waitForWindowHeadroom(env.raw, 60000);
    const before = await countUploadIntents(env.isolated.runtime);
    const r2Before = env.objectServer.requests.length;

    const expected = [201, 201, 201, 429, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Issue(instance, env.owner, randomUUID(), RL06_COLLECTION);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `issue through ${instance.name} expected ${expected[i]}`);
      if (response.statusCode === 429) {
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limited');
        assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
        assert.equal(response.headers['retry-after'], String(problem.error.retryAfterSeconds));
        assert.equal(response.headers['ratelimit-policy'], 'attachments-issue:3:60000');
      }
    }
    assert.deepEqual(statuses, expected, 'the alternating statuses prove BOTH instances enforce the shared budget');
    // Anti-false-positive: the requests really alternated across both
    // instances and BOTH used their own Redis clients.
    assert.equal(pair.a.requests, 3, 'instance A served its alternating requests');
    assert.equal(pair.b.requests, 2, 'instance B served its alternating requests');
    assert.ok(pair.a.counts.evalshaCalls >= 3, 'instance A ran admission through its OWN Redis client');
    assert.ok(pair.b.counts.evalshaCalls >= 2, 'instance B ran admission through its OWN Redis client');
    // B denied at its SECOND served attempt while B's own in-process state
    // would allow it (issue has no local limiter): only the SHARED Redis
    // counter can explain the denial.
    assert.equal(await countUploadIntents(env.isolated.runtime), before + 3, 'exactly the three allowed issues created ledger rows');
    assert.equal(env.objectServer.requests.length, r2Before, 'issue does zero R2 work');
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1, 'one shared counter key for both instances');
    assert.equal(await env.raw.get(issueKeys[0]!), '5', 'every network attempt across BOTH instances counts');
    assert.equal(parseAttachmentRateLimitKey(issueKeys[0]!).kind, 'ok');
  }, 60_000);

  test('download admission budget is shared; the 429 path does zero use-case/DB/R2 work', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    await waitForWindowHeadroom(env.raw, 60000);
    const { binding } = await prepareStored(env, pair, env.owner, p07Body(21));
    const callsBefore = pair.a.downloadCalls() + pair.b.downloadCalls();
    const outboxBefore = await countOutboxEvents(env.isolated.runtime);
    const r2Before = env.objectServer.requests.length;
    const servedBefore = pair.served();

    const expected = [200, 200, 429, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Admit(instance, env.owner, binding.blobId);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `admit through ${instance.name} expected ${expected[i]}`);
      if (response.statusCode === 429) {
        assert.equal(response.headers['ratelimit-policy'], 'attachments-download:2:60000');
        assert.ok(response.headers['retry-after'] !== undefined, 'the 429 carries the real quota fact');
      }
    }
    assert.deepEqual(statuses, expected);
    // Deltas: the prepare (issue on A, complete on B) also counted as served.
    assert.equal(pair.a.requests - servedBefore.a, 2, 'instance A served two alternating admits');
    assert.equal(pair.b.requests - servedBefore.b, 2, 'instance B served two alternating admits');
    assert.ok(pair.a.counts.evalshaCalls >= 2 && pair.b.counts.evalshaCalls >= 2, 'both instances consulted Redis');
    assert.equal(pair.a.downloadCalls() + pair.b.downloadCalls(), callsBefore + 2, 'the download USE CASE ran exactly twice');
    assert.equal(await countOutboxEvents(env.isolated.runtime), outboxBefore, 'denied admits add zero outbox rows');
    assert.equal(env.objectServer.requests.length, r2Before, 'denied admits do zero R2 work');
    const downloadKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':download:'));
    assert.equal(downloadKeys.length, 1);
    assert.equal(await env.raw.get(downloadKeys[0]!), '4');
  }, 60_000);

  test('route isolation: an exhausted issue budget never blocks download/complete admission', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    await waitForWindowHeadroom(env.raw, 60000);
    const { binding, etag } = await prepareStored(env, pair, env.owner, p07Body(23));

    // issue budget 2: the prepare used slot 1 (A); consume slot 2 on B, then
    // the third attempt (A) is exhausted.
    assert.equal((await rl06Issue(pair.b, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(pair.a, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'issue exhausted');

    // download and complete routes are NOT affected by the issue exhaustion.
    assert.equal((await rl06Admit(pair.a, env.owner, binding.blobId)).statusCode, 200, 'download unaffected');
    assert.equal((await rl06Admit(pair.b, env.owner, binding.blobId)).statusCode, 200, 'download unaffected on B');
    const replay = await rl06Complete(pair.a, env.owner, binding, p07Body(23), etag, randomUUID());
    assert.equal(replay.statusCode, 200, 'complete unaffected by issue exhaustion');
    assert.equal((await rl06Issue(pair.b, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'issue stays exhausted');

    // Route-class key separation under one prefix: one key per route, exact counters.
    const keys = await env.raw.keys(`${prefix}:*`);
    const routeClasses = new Set<string>();
    for (const key of keys) {
      const parsed = parseAttachmentRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', 'every run key is a canonical codec key');
      if (parsed.kind === 'ok') routeClasses.add(parsed.parts.routeClass);
    }
    assert.deepEqual([...routeClasses].sort(), ['complete', 'download', 'issue']);
    // Four issue attempts total (2 allowed + 2 exhausted) — every network
    // attempt counts into the shared counter (plan §4.2.9), including the
    // final exhausted attempt.
    assert.equal(await env.raw.get(keys.find((key) => key.includes(':issue:'))!), '4');
    assert.equal(await env.raw.get(keys.find((key) => key.includes(':complete:'))!), '2');
    assert.equal(await env.raw.get(keys.find((key) => key.includes(':download:'))!), '2');
  }, 60_000);

  test('principal isolation; the status control route keeps working while exhausted (FIX-M-017 per-principal budget)', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    await waitForWindowHeadroom(env.raw, 60000);
    const { binding } = await prepareStored(env, pair, env.owner, p07Body(29));

    // owner exhausts the per-principal issue budget (prepare used slot 1 on A; slot 2 on B; then denied).
    assert.equal((await rl06Issue(pair.b, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(pair.a, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'owner exhausted');

    // A DIFFERENT principal is unaffected (isolation).
    assert.equal((await rl06Issue(pair.b, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 201, 'principal isolation');
    // The SAME principal into a DIFFERENT collection scope shares the same
    // per-principal budget (FIX-M-017 fixed-scope admission): still denied.
    assert.equal((await rl06Issue(pair.a, env.owner, randomUUID(), RL06_COLLECTION_SCOPE)).statusCode, 429,
      'scope shares the per-principal budget');
    // Control route: the owner status read still works while issue is exhausted.
    assert.equal((await rl06Status(pair.b, env.owner, binding.blobId)).statusCode, 200, 'control route unaffected');
    assert.equal((await rl06Status(pair.a, env.owner, binding.blobId)).statusCode, 200);

    // Two distinct counter keys: (owner)=4, (other)=1 — one per principal,
    // never per collection scope.
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 2, 'one counter key per principal');
    const values = (await Promise.all(issueKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '4'], 'each principal counts only its own attempts');
  }, 60_000);

  test('shadow and enforce instances observe ONE counter: shadow never denies, enforce 429s at budget+1', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 3, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }, { modeB: 'shadow' });
    await waitForWindowHeadroom(env.raw, 60000);
    const before = await countUploadIntents(env.isolated.runtime);

    // A=enforce, B=shadow on the SAME prefix+secret+budget: the shadow
    // instance's counting is visible to the enforce instance and vice versa.
    const expected = [201, 201, 201, 201, 429, 201, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Issue(instance, env.owner, randomUUID(), RL06_COLLECTION);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `issue through ${instance.name} expected ${expected[i]}`);
    }
    assert.deepEqual(statuses, expected);
    assert.equal(pair.a.requests, 4);
    assert.equal(pair.b.requests, 3);
    assert.equal(await countUploadIntents(env.isolated.runtime), before + 5, 'shadow allowed all three of its attempts; enforce allowed two');
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1);
    assert.equal(await env.raw.get(issueKeys[0]!), '7', 'both modes count into the SAME shared counter');

    // Observability of the shadow -> enforce boundary (plan §13.1): the
    // shadow instance records the mismatch whenever Redis denies but the
    // local reference allows; the enforce instance records the real denials.
    assert.equal(pair.b.bundle.metrics.get('attachments.rate_limit.shadow_mismatch'), 2, 'shadow recorded both Redis denials');
    const shadowLog = pair.b.logEntries.slice(-3);
    assert.deepEqual(shadowLog.map((entry) => entry.decision), ['allowed', 'allowed', 'allowed']);
    assert.deepEqual(shadowLog.map((entry) => entry.shadowMismatch), [false, true, true]);
    const enforceLog = pair.a.logEntries.slice(-4);
    assert.deepEqual(enforceLog.map((entry) => entry.decision), ['allowed', 'allowed', 'denied', 'denied']);
  }, 60_000);

  test('shadow download: per-instance local limiters are independent while the Redis counter is shared', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const localA = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 1, maxTrackedPrincipals: 8 });
    const localB = createDeliveryRateLimiter({ windowSeconds: 60, maxPerWindow: 1, maxTrackedPrincipals: 8 });
    const pair = await newPair(prefix, {
      mode: 'shadow',
      required: false,
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 1, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }),
    }, { localLimiterA: localA, localLimiterB: localB });
    await waitForWindowHeadroom(env.raw, 60000);
    const { binding } = await prepareStored(env, pair, env.owner, p07Body(37));
    const callsBefore = pair.a.downloadCalls() + pair.b.downloadCalls();
    const servedBefore = pair.served();

    // Each instance's OWN local limiter allows exactly one attempt. If the
    // two instances SHARED one in-memory limiter, the second request (B)
    // would already be denied; it is not — independent process-local state.
    const expected = [200, 200, 429, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Admit(instance, env.owner, binding.blobId);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `shadow admit through ${instance.name} expected ${expected[i]}`);
    }
    assert.deepEqual(statuses, expected, 'B was allowed while a shared local limiter would have denied it');
    // Deltas: the prepare (issue on A, complete on B) also counted as served.
    assert.equal(pair.a.requests - servedBefore.a, 2);
    assert.equal(pair.b.requests - servedBefore.b, 2);
    assert.ok(pair.a.counts.evalshaCalls >= 2 && pair.b.counts.evalshaCalls >= 2, 'both shadow clients consulted Redis');
    assert.equal(pair.a.downloadCalls() + pair.b.downloadCalls(), callsBefore + 2, 'exactly the two allowed admits ran the use case');
    assert.equal(pair.b.bundle.metrics.get('attachments.rate_limit.shadow_mismatch'), 1, 'B saw the shared Redis counter deny its first attempt');
    const downloadKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':download:'));
    assert.equal(downloadKeys.length, 1);
    assert.equal(await env.raw.get(downloadKeys[0]!), '4', 'the shared Redis counter saw all four attempts');
  }, 60_000);

  test('API restart: quota state survives in Redis — no reset, no double count', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-restart-${randomUUID()}`, 'utf8');
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) }, { keySecret });
    await waitForWindowHeadroom(env.raw, 60000);
    const before = await countUploadIntents(env.isolated.runtime);

    assert.equal((await rl06Issue(pair.a, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(pair.b, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(pair.a, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429);
    assert.equal(await countUploadIntents(env.isolated.runtime), before + 2);

    // Snapshot the shared counter, then shut instance A down completely
    // (app + its own Redis client + in-process state).
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 1);
    assert.equal(await env.raw.get(issueKeys[0]!), '3');
    await pair.a.bundle.close();
    assert.equal(await env.raw.get(issueKeys[0]!), '3', 'the shutdown does not reset the counter');

    // The SURVIVING instance B still works on its own client and still sees
    // the shared state (independent client, no reset).
    assert.equal((await rl06Issue(pair.b, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'survivor enforces the persisted counter');
    assert.equal(await env.raw.get(issueKeys[0]!), '4');

    // "API restart": a BRAND-NEW composition with the same prefix + secret
    // (fresh Redis client, fresh local state) inherits the persisted quota.
    const restarted = await buildRl06Instance('A-restarted', {
      runtime: env.isolated,
      databaseUrl: env.isolated.databaseUrl,
      identityUnitOfWork: env.identityUnitOfWork,
      browserSessionAuthority: env.factory.authority,
      objectServerUrl: env.objectServer.url,
      attachmentsConfig: makeP03Config(),
      rateLimitConfig: makeRl06RateLimitConfig(env.redisUrl, prefix, { routes: Object.freeze({
        issue: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      }) }),
      keySecret,
    });
    openBundles.push(restarted.bundle);
    assert.equal((await rl06Issue(restarted, env.owner, randomUUID(), RL06_COLLECTION)).statusCode, 429, 'the restarted instance inherits the counter');
    assert.equal(await env.raw.get(issueKeys[0]!), '5', 'no double count across the restart');
    assert.equal(await countUploadIntents(env.isolated.runtime), before + 2, 'the restart created zero extra ledger rows');

    // A different principal is unaffected (control): fresh budget 2.
    assert.equal((await rl06Issue(pair.b, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(restarted, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 201);
    assert.equal((await rl06Issue(pair.b, env.other, randomUUID(), RL06_COLLECTION)).statusCode, 429);
  }, 60_000);

  test('hot-key load: one subject hammering ONE shared key across both instances stays exact and crash-free', async () => {
    const prefix = `rl06-${randomUUID()}`;
    const pair = await newPair(prefix, { routes: Object.freeze({
      issue: Object.freeze({ rateMax: 10, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 5, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }) });
    await waitForWindowHeadroom(env.raw, 60000);

    // Prepare a stored object through `other` so the OWNER's issue budget
    // stays fresh for the hot-key burst and `other` owns the blob for the
    // download hot-key burst. Side-effect snapshots are taken AFTER the
    // prepare so the bursts are measured in isolation.
    const { binding } = await prepareStored(env, pair, env.other, p07Body(41));
    const before = await countUploadIntents(env.isolated.runtime);
    const r2Before = env.objectServer.requests.length;
    const servedBefore = pair.served();

    const total = 20;
    const statuses: number[] = [];
    for (let i = 0; i < total; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Issue(instance, env.owner, randomUUID(), RL06_COLLECTION);
      statuses.push(response.statusCode);
    }
    assert.equal(statuses.filter((status) => status === 201).length, 10, 'exactly the budget allowed');
    assert.equal(statuses.filter((status) => status === 429).length, 10, 'every over-budget attempt denied');
    assert.ok(statuses.every((status) => status === 201 || status === 429), 'no 5xx/other statuses under hot-key load');
    // Deltas: the prepare (issue on A, complete on B) also counted as served.
    assert.equal(pair.a.requests - servedBefore.a, 10, 'hot-key load alternated evenly');
    assert.equal(pair.b.requests - servedBefore.b, 10, 'hot-key load alternated evenly');
    assert.ok(pair.a.counts.evalshaCalls >= 10 && pair.b.counts.evalshaCalls >= 10, 'both clients hammered the shared key');
    assert.equal(await countUploadIntents(env.isolated.runtime), before + 10, 'exactly the allowed hot-key issues created rows');
    assert.equal(env.objectServer.requests.length, r2Before, 'issue does zero R2 work');
    const issueKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':issue:'));
    assert.equal(issueKeys.length, 2, 'one key per principal: the prepare subject and the hot-key subject');
    // The hot-key burst all landed on ONE shared key (the owner's), whose
    // counter is exactly the attempt count; the prepare subject's key (value 1)
    // is the second key.
    const burstValues = await Promise.all(issueKeys.map((key) => env.raw.get(key)));
    const burstKey = issueKeys[burstValues.indexOf(String(total))]!;
    assert.equal(burstValues.filter((value) => value === String(total)).length, 1, 'ONE shared hot key for the whole burst');
    assert.equal(parseAttachmentRateLimitKey(burstKey).kind, 'ok');

    // Download hot key on the SAME subject: one blob, one key, exact budget.
    const outboxBefore = await countOutboxEvents(env.isolated.runtime);
    const admitTotal = 8;
    const admitStatuses: number[] = [];
    for (let i = 0; i < admitTotal; i += 1) {
      const instance = alternate(pair, i);
      const response = await rl06Admit(instance, env.other, binding.blobId);
      admitStatuses.push(response.statusCode);
    }
    assert.equal(admitStatuses.filter((status) => status === 200).length, 5, 'download hot key allows exactly its budget');
    assert.equal(admitStatuses.filter((status) => status === 429).length, 3, 'download hot key denies the rest');
    assert.ok(admitStatuses.every((status) => status === 200 || status === 429), 'no 5xx/other statuses on the download hot key');
    assert.equal(pair.a.downloadCalls() + pair.b.downloadCalls(), 5, 'the use case ran exactly the allowed admits');
    assert.equal(await countOutboxEvents(env.isolated.runtime), outboxBefore, 'denied download admits add zero outbox rows');
    const downloadKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':download:'));
    assert.equal(downloadKeys.length, 1, 'ONE shared download hot key');
    assert.equal(await env.raw.get(downloadKeys[0]!), String(admitTotal));
  }, 60_000);

  test('auth rate limit: two instances share ONE client-IP budget with alternation; other IPs and route families stay isolated', async () => {
    const prefix = `rl06-auth-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-auth-secret-${randomUUID()}`, 'utf8');
    const maxRequests = 3;
    const windowMs = 60_000;
    await waitForWindowHeadroom(env.raw, windowMs);
    const pair = await buildAuthPair(prefix, keySecret, maxRequests, windowMs);
    const ip = '203.0.113.10';

    // Same client IP alternating across BOTH instances: the combined budget
    // is exactly ONE quota (3), never 2x3 — only the SHARED Redis counter can
    // explain the denials.
    const expected = [200, 200, 200, 429, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = i % 2 === 0 ? pair.a : pair.b;
      const response = await authSession(instance, ip);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `session through ${instance.name} expected ${expected[i]}`);
      if (response.statusCode === 429) {
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limited');
        assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
        assert.equal(response.headers['retry-after'], String(problem.error.retryAfterSeconds));
        assert.equal(response.headers['ratelimit-policy'], `auth:session:${maxRequests}:${windowMs}`);
      }
    }
    assert.deepEqual(statuses, expected, 'the alternating statuses prove BOTH instances enforce the shared auth budget');
    // Anti-false-positive: the requests really alternated and BOTH instances
    // ran admission through their OWN Redis clients.
    assert.equal(pair.a.requests, 3, 'instance A served its alternating auth requests');
    assert.equal(pair.b.requests, 2, 'instance B served its alternating auth requests');
    assert.ok(pair.a.counts.evalshaCalls >= 3, 'instance A ran auth admission through its OWN Redis client');
    assert.ok(pair.b.counts.evalshaCalls >= 2, 'instance B ran auth admission through its OWN Redis client');

    // A DIFFERENT client IP is fully isolated (fresh budget on the same pair).
    const otherIp = '198.51.100.20';
    const isolated = await authSession(pair.a, otherIp);
    assert.equal(isolated.statusCode, 200, 'a different client IP stays isolated');

    // A DIFFERENT route family from the SAME IP stays isolated: /api/v1/me is
    // admitted through the limiter (401 unauthenticated, never 429) while the
    // session family stays exhausted.
    const me = await authMe(pair.b, ip);
    assert.equal(me.statusCode, 401, 'the me family is not blocked by session-family exhaustion');
    const sessionStillExhausted = await authSession(pair.a, ip);
    assert.equal(sessionStillExhausted.statusCode, 429, 'the session family stays exhausted');

    // One shared counter key per client IP, exact attempt counts across BOTH
    // instances (6 session attempts on ip, 1 on otherIp; 1 me-family attempt).
    const sessionKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':session:'));
    assert.equal(sessionKeys.length, 2, 'one shared session counter key per client IP');
    const values = (await Promise.all(sessionKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '6'], 'every network attempt across BOTH instances counts into the shared counter');
    for (const key of sessionKeys) {
      assert.equal(parseAuthRateLimitKey(key).kind, 'ok', 'the counter key is a canonical auth codec key');
    }
    const meKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':me:'));
    assert.equal(meKeys.length, 1, 'one shared me-family counter key');
    assert.equal(await env.raw.get(meKeys[0]!), '1');
  }, 60_000);

  test('auth rate limit: a Redis outage fails closed (503, no quota facts) on both instances and recovers after restart', async () => {
    const prefix = `rl06-auth-outage-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-auth-outage-secret-${randomUUID()}`, 'utf8');
    const maxRequests = 3;
    const windowMs = 60_000;
    await waitForWindowHeadroom(env.raw, windowMs);
    const pair = await buildAuthPair(prefix, keySecret, maxRequests, windowMs);
    const ip = '203.0.113.30';

    // Baseline: the shared store works before the outage.
    assert.equal((await authSession(pair.a, ip)).statusCode, 200);

    // Stop the REAL redis-server PROCESS (same containment as the RL06
    // outage suite); container exec failures are environment failures.
    const shutdown = await env.container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // BOTH instances fail closed with 503 and NO fabricated quota facts
      // (plan §4.1.10: an outage is never presented as quota exhaustion).
      for (const instance of [pair.a, pair.b]) {
        const response = await authSession(instance, ip);
        assert.equal(response.statusCode, 503, `session on ${instance.name} must fail closed during the outage`);
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'feature_temporarily_unavailable');
        assert.equal(problem.error.retryAfterSeconds, null);
        assert.equal(response.headers['retry-after'], undefined, 'a 503 never fabricates a quota fact');
        assert.equal(response.headers['ratelimit-policy'], undefined, 'a 503 never fabricates a quota policy');
      }
      // Non-auth routes stay available during the auth-limiter outage.
      assert.equal((await authHealth(pair.a)).statusCode, 200);
    } finally {
      const restore = await env.container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Recovery health barrier (polling, no fixed sleep): a circuit breaker
    // only transitions through a real store check, and the script cache was
    // flushed by the restart (NOSCRIPT reload path). The successful probe
    // consumes exactly one unit.
    const recoveredIp = '203.0.113.40';
    await waitUntil(async () => {
      const response = await authSession(pair.a, recoveredIp);
      return response.statusCode === 200;
    }, 20_000, 'auth rate-limit recovery on instance A', 250);
    assert.equal((await authSession(pair.a, recoveredIp)).statusCode, 200, 'budget unit 2');
    assert.equal((await authSession(pair.a, recoveredIp)).statusCode, 200, 'budget unit 3');
    const over = await authSession(pair.a, recoveredIp);
    assert.equal(over.statusCode, 429, 'the recovered shared budget is enforced again');
    if (over.statusCode === 429) {
      assert.equal(over.headers['ratelimit-policy'], `auth:session:${maxRequests}:${windowMs}`);
    }

    // Instance B recovers through its OWN client (fresh IP).
    const recoveredB = '198.51.100.40';
    await waitUntil(async () => {
      const response = await authSession(pair.b, recoveredB);
      return response.statusCode === 200;
    }, 20_000, 'auth rate-limit recovery on instance B', 250);
    const sessionKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':session:'));
    // The restarted server may or may not have persisted the pre-outage key
    // (RDB snapshot state is environment-dependent), so only the exact
    // recovered counters are pinned.
    assert.ok(sessionKeys.length >= 2, 'recovered session counter keys exist');
    const values = new Map(await Promise.all(sessionKeys.map(async (key) => [key, await env.raw.get(key)] as const)));
    const recoveredKeys = sessionKeys.filter((key) => values.get(key) !== undefined);
    assert.equal(
      recoveredKeys.filter((key) => values.get(key) === '4').length, 1,
      'the recovered shared-budget key has exactly 4 attempts (probe + 3 budget units)',
    );
    assert.ok(
      recoveredKeys.filter((key) => values.get(key) === '1').length >= 1,
      'the recovered fresh-IP key has exactly 1 attempt',
    );
  }, 60_000);

  test('Search rate limit: two replicas behind ONE trusted proxy peer share ONE anonymous budget; client IPs stay isolated', async () => {
    const prefix = `rl06-search-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-search-secret-${randomUUID()}`, 'utf8');
    const anonMax = 3;
    const windowMs = 60_000;
    await waitForWindowHeadroom(env.raw, windowMs);
    const pair = await buildSearchPair(prefix, keySecret, anonMax, 3, windowMs);
    const clientA = '203.0.113.10';

    // The same client IP alternating across BOTH instances through the
    // trusted nginx peer: the combined budget is exactly ONE quota (3), never
    // 2x3 — only the SHARED Redis counter can explain the denials.
    const expected = [200, 200, 200, 429, 429];
    const statuses: number[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = i % 2 === 0 ? pair.a : pair.b;
      const response = await searchViaProxy(instance, clientA);
      statuses.push(response.statusCode);
      assert.equal(response.statusCode, expected[i]!, `search through ${instance.name} expected ${expected[i]}`);
      if (response.statusCode === 429) {
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'rate_limited');
        assert.ok(problem.error.retryAfterSeconds !== null && problem.error.retryAfterSeconds >= 1);
        assert.equal(response.headers['retry-after'], String(problem.error.retryAfterSeconds));
        assert.equal(response.headers['ratelimit-policy'], `search:anonymous:${anonMax}:${windowMs}`);
      }
    }
    assert.deepEqual(statuses, expected, 'the alternating statuses prove BOTH instances enforce the shared anonymous budget');
    // Anti-false-positive: the requests really alternated and BOTH instances
    // ran admission through their OWN Redis clients.
    assert.equal(pair.a.requests, 3, 'instance A served its alternating search requests');
    assert.equal(pair.b.requests, 2, 'instance B served its alternating search requests');
    assert.ok(pair.a.counts.evalshaCalls >= 3, 'instance A ran search admission through its OWN Redis client');
    assert.ok(pair.b.counts.evalshaCalls >= 2, 'instance B ran search admission through its OWN Redis client');

    // A DIFFERENT client IP through the SAME trusted peer is fully isolated.
    const other = await searchViaProxy(pair.a, '198.51.100.20');
    assert.equal(other.statusCode, 200, 'a different client IP stays isolated');

    // One shared counter key per client IP, exact attempt counts across BOTH
    // instances (5 attempts on clientA, 1 on the other IP).
    const anonymousKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':anonymous:'));
    assert.equal(anonymousKeys.length, 2, 'one shared anonymous counter key per client IP');
    const values = (await Promise.all(anonymousKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '5'], 'every network attempt across BOTH instances counts into the shared counter');
    for (const key of anonymousKeys) {
      assert.equal(parseSearchRateLimitKey(key).kind, 'ok', 'the counter key is a canonical search codec key');
    }
  }, 60_000);

  test('Search rate limit: an UNTRUSTED peer spoofed XFF is ignored — direct connections share the PEER bucket', async () => {
    const prefix = `rl06-search-direct-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-search-direct-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildSearchPair(prefix, keySecret, 2, 2, 60_000);

    // Direct connections (peer NOT inside the trusted-ingress allowlist): the
    // spoofed XFF never opens a new bucket; the PEER address keys the budget.
    const peer = '198.51.100.9';
    assert.equal((await searchDirect(pair.a, peer, '203.0.113.10')).statusCode, 200);
    assert.equal((await searchDirect(pair.b, peer, '198.51.100.20')).statusCode, 200,
      'a different spoofed XFF shares the same peer bucket across replicas');
    const third = await searchDirect(pair.a, peer, '9.9.9.9');
    assert.equal(third.statusCode, 429, 'the peer bucket is exhausted regardless of the spoofed header');
    assert.equal(third.headers['ratelimit-policy'], 'search:anonymous:2:60000');
    // A DIFFERENT untrusted peer has its own bucket.
    assert.equal((await searchDirect(pair.b, '198.51.100.10', '203.0.113.10')).statusCode, 200);

    const anonymousKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':anonymous:'));
    assert.equal(anonymousKeys.length, 2, 'one counter key per PEER address, never per spoofed XFF');
    const values = (await Promise.all(anonymousKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '3'], 'the peer bucket counted every direct attempt across BOTH instances');
    for (const key of anonymousKeys) {
      assert.equal(parseSearchRateLimitKey(key).kind, 'ok');
    }
  }, 60_000);

  test('real nginx -> two API replicas -> shared Redis: the API resolves the client behind the trusted proxy and ONE budget spans both replicas', async () => {
    const prefix = `rl06-search-nginx-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-search-nginx-secret-${randomUUID()}`, 'utf8');
    const anonMax = 3;
    await waitForWindowHeadroom(env.raw, 60_000);
    // The API instances trust the docker bridge ranges (nginx peer + host
    // gateway hop, whatever concrete subnet Docker picked); the host loopback
    // stays UNTRUSTED for the direct-spoof leg.
    const pair = await buildSearchPair(prefix, keySecret, anonMax, 3, 60_000,
      '172.16.0.0/12,10.0.0.0/8,192.168.0.0/16');
    const addressA = await pair.a.app.listen({ host: '0.0.0.0', port: 0 });
    const addressB = await pair.b.app.listen({ host: '0.0.0.0', port: 0 });
    const portA = Number(new URL(addressA).port);
    const portB = Number(new URL(addressB).port);
    let nginx: StartedTestContainer | undefined;
    try {
      nginx = await startSearchNginx(portA, portB);
      const nginxPort = nginx.getMappedPort(80);
      await waitForTcp(nginxPort);

      // One client through REAL nginx (same XFF rewriting as the repo
      // devops/docker/nginx.conf): its budget is shared across BOTH replicas
      // (round-robin alternates the upstreams) and the API resolves the real
      // client behind the trusted peer.
      const expected = [200, 200, 200, 429, 429];
      const statuses: number[] = [];
      for (let i = 0; i < expected.length; i += 1) {
        const response = await rawSearchHttp(nginxPort, '/api/v1/search?q=topology',
          { accept: 'application/json', 'x-forwarded-for': '203.0.113.10' });
        statuses.push(response.statusCode);
        assert.equal(response.statusCode, expected[i]!, `through nginx expected ${expected[i]}`);
        if (response.statusCode === 429) {
          assert.equal(response.headers['ratelimit-policy'], `search:anonymous:${anonMax}:60000`);
          assert.ok(response.headers['retry-after'] !== undefined, 'the 429 carries the real quota fact');
        }
      }
      assert.deepEqual(statuses, expected, 'nginx round-robin served both replicas against ONE shared budget');
      assert.ok(pair.a.counts.evalshaCalls >= 2 && pair.b.counts.evalshaCalls >= 2,
        'nginx round-robin delivered search admission to BOTH replicas through their OWN Redis clients');

      // A second client through the same nginx is isolated.
      assert.equal((await rawSearchHttp(nginxPort, '/api/v1/search?q=topology',
        { accept: 'application/json', 'x-forwarded-for': '198.51.100.20' })).statusCode, 200);

      // Direct connection to a replica (bypassing nginx): the spoofed XFF is
      // ignored because the loopback peer is not a trusted ingress; all direct
      // attempts share the loopback PEER bucket (budget 3: the 4th attempt in
      // the window is denied — the 3rd is still allowed under count <= max).
      assert.equal((await rawSearchHttp(portA, '/api/v1/search?q=topology',
        { accept: 'application/json', 'x-forwarded-for': '9.9.9.9' })).statusCode, 200);
      assert.equal((await rawSearchHttp(portA, '/api/v1/search?q=topology',
        { accept: 'application/json', 'x-forwarded-for': '8.8.8.8' })).statusCode, 200);
      assert.equal((await rawSearchHttp(portA, '/api/v1/search?q=topology',
        { accept: 'application/json', 'x-forwarded-for': '7.7.7.7' })).statusCode, 200);
      const directFourth = await rawSearchHttp(portA, '/api/v1/search?q=topology',
        { accept: 'application/json', 'x-forwarded-for': '6.6.6.6' });
      assert.equal(directFourth.statusCode, 429, 'the loopback peer bucket is exhausted; spoofed XFF never rotates it');

      const anonymousKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':anonymous:'));
      assert.equal(anonymousKeys.length, 3, 'one key per resolved identity: two nginx clients + the loopback peer');
      const values = (await Promise.all(anonymousKeys.map((key) => env.raw.get(key)))).sort();
      assert.deepEqual(values, ['1', '4', '5'], 'exact shared counters for every resolved identity');
      for (const key of anonymousKeys) {
        assert.equal(parseSearchRateLimitKey(key).kind, 'ok');
      }
    } finally {
      await nginx?.stop().catch(() => undefined);
    }
  }, 120_000);

  test('Search rate limit: a Redis outage fails closed (503, no quota facts) on both replicas and recovers', async () => {
    const prefix = `rl06-search-outage-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-search-outage-secret-${randomUUID()}`, 'utf8');
    const anonMax = 3;
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildSearchPair(prefix, keySecret, anonMax, 3, 60_000);
    const clientIp = '203.0.113.30';

    // Baseline: the shared store works before the outage.
    assert.equal((await searchViaProxy(pair.a, clientIp)).statusCode, 200);

    // Stop the REAL redis-server PROCESS (same containment as the auth
    // outage test); container exec failures are environment failures.
    const shutdown = await env.container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // BOTH instances fail closed with 503 and NO fabricated quota facts.
      for (const instance of [pair.a, pair.b]) {
        const response = await searchViaProxy(instance, clientIp);
        assert.equal(response.statusCode, 503, `search on ${instance.name} must fail closed during the outage`);
        const problem = rl06ProblemOf(response.body);
        assert.equal(problem.error.code, 'feature_temporarily_unavailable');
        assert.equal(problem.error.retryAfterSeconds, null);
        assert.equal(response.headers['retry-after'], undefined, 'a 503 never fabricates a quota fact');
        assert.equal(response.headers['ratelimit-policy'], undefined, 'a 503 never fabricates a quota policy');
      }
      // Non-search routes stay available during the search-limiter outage.
      assert.equal((await searchHealth(pair.a)).statusCode, 200);
    } finally {
      const restore = await env.container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Recovery health barrier (polling, no fixed sleep): the circuit breaker
    // only transitions through a real store check and the script cache was
    // flushed by the restart (NOSCRIPT reload path). The successful probe
    // consumes exactly one unit.
    const recoveredIp = '203.0.113.40';
    await waitUntil(async () => {
      const response = await searchViaProxy(pair.a, recoveredIp);
      return response.statusCode === 200;
    }, 20_000, 'search rate-limit recovery on instance A', 250);
    assert.equal((await searchViaProxy(pair.a, recoveredIp)).statusCode, 200, 'budget unit 2');
    assert.equal((await searchViaProxy(pair.a, recoveredIp)).statusCode, 200, 'budget unit 3');
    const over = await searchViaProxy(pair.a, recoveredIp);
    assert.equal(over.statusCode, 429, 'the recovered shared budget is enforced again');
    if (over.statusCode === 429) {
      assert.equal(over.headers['ratelimit-policy'], `search:anonymous:${anonMax}:60000`);
    }

    // Instance B recovers through its OWN client (fresh IP).
    const recoveredB = '198.51.100.40';
    await waitUntil(async () => {
      const response = await searchViaProxy(pair.b, recoveredB);
      return response.statusCode === 200;
    }, 20_000, 'search rate-limit recovery on instance B', 250);

    const anonymousKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':anonymous:'));
    // The restarted server may or may not have persisted the pre-outage key
    // (RDB snapshot state is environment-dependent), so only the exact
    // recovered counters are pinned.
    assert.ok(anonymousKeys.length >= 2, 'recovered anonymous counter keys exist');
    const values = new Map(await Promise.all(anonymousKeys.map(async (key) => [key, await env.raw.get(key)] as const)));
    const recoveredKeys = anonymousKeys.filter((key) => values.get(key) !== undefined);
    assert.equal(
      recoveredKeys.filter((key) => values.get(key) === '4').length, 1,
      'the recovered shared-budget key has exactly 4 attempts (probe + 3 budget units)',
    );
    assert.ok(
      recoveredKeys.filter((key) => values.get(key) === '1').length >= 1,
      'the recovered fresh-IP key has exactly 1 attempt',
    );
  }, 60_000);

  test('MCP request policy: two instances share ONE per-principal budget with alternation', async () => {
    const prefix = `rl06-mcp-req-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-mcp-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildMcpPair(prefix, keySecret, mcpBudgets(3, 2, 2));
    const facts = mcpBindingFacts('principal-1');

    // The same subject alternating across BOTH instances: the combined
    // budget is exactly ONE quota (3), never 2x3 — only the SHARED Redis
    // counter can explain the denials.
    const expected = ['allowed', 'allowed', 'allowed', 'denied', 'denied'] as const;
    const outcomes: string[] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const instance = i % 2 === 0 ? pair.a : pair.b;
      const outcome = await instance.limiter.consume({ policy: 'request', facts });
      outcomes.push(outcome.kind);
      assert.equal(outcome.kind, expected[i]!, `request through ${instance.name} expected ${expected[i]}`);
      if (outcome.kind === 'denied') {
        assert.ok(outcome.decision.retryAfterSeconds >= 1, 'the denied decision carries the retry-after fact');
      }
    }
    assert.deepEqual(outcomes, [...expected], 'the alternating outcomes prove BOTH instances enforce the shared budget');
    // Anti-false-positive: BOTH instances ran admission through their OWN
    // Redis clients (no shared in-process state).
    assert.ok(pair.a.counts.evalshaCalls >= 3, 'instance A ran request admission through its OWN Redis client');
    assert.ok(pair.b.counts.evalshaCalls >= 2, 'instance B ran request admission through its OWN Redis client');

    // A DIFFERENT principal is fully isolated (fresh budget on the same pair).
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'request', facts: mcpBindingFacts('principal-2') })).kind,
      'allowed',
      'a different principal stays isolated',
    );

    // One shared counter key per principal, exact attempt counts across BOTH
    // instances (5 attempts on principal-1, 1 on principal-2).
    const requestKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':request:'));
    assert.equal(requestKeys.length, 2, 'one shared request counter key per principal');
    const values = (await Promise.all(requestKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '5'], 'every admission attempt across BOTH instances counts into the shared counter');
    for (const key of requestKeys) {
      assert.equal(parseMcpRateLimitKey(key).kind, 'ok', 'the counter key is a canonical mcp codec key');
    }
  }, 60_000);

  test('MCP approval policy: two instances share ONE per-principal budget; route family and principal stay isolated', async () => {
    const prefix = `rl06-mcp-approval-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-mcp-approval-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildMcpPair(prefix, keySecret, mcpBudgets(10, 2, 10));
    const facts = mcpApprovalFacts(MCP_APPROVAL_LIST_FAMILY, 'principal-1');

    // Same approval subject alternating across BOTH instances: ONE budget (2).
    const expected = ['allowed', 'allowed', 'denied'] as const;
    for (let i = 0; i < expected.length; i += 1) {
      const instance = i % 2 === 0 ? pair.a : pair.b;
      const outcome = await instance.limiter.consume({ policy: 'approval', facts });
      assert.equal(outcome.kind, expected[i]!, `approval through ${instance.name} expected ${expected[i]}`);
    }
    assert.ok(pair.a.counts.evalshaCalls >= 2 && pair.b.counts.evalshaCalls >= 1,
      'both instances consulted Redis for approval');

    // A DIFFERENT principal is isolated; the SAME principal on a DIFFERENT
    // sealed route family is isolated (LIST budget stays exhausted).
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'approval', facts: mcpApprovalFacts(MCP_APPROVAL_LIST_FAMILY, 'principal-2') })).kind,
      'allowed',
      'a different principal stays isolated',
    );
    assert.equal(
      (await pair.b.limiter.consume({ policy: 'approval', facts: mcpApprovalFacts(MCP_APPROVAL_DECISION_FAMILY, 'principal-1') })).kind,
      'allowed',
      'the decision family is not blocked by LIST-family exhaustion',
    );
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'approval', facts })).kind,
      'denied',
      'the LIST family stays exhausted',
    );

    // Three counter keys: (LIST, principal-1)=4 (the three loop attempts
    // plus the trailing "stays exhausted" check below), (LIST,
    // principal-2)=1, (DECISION, principal-1)=1.
    const approvalKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':approval:'));
    assert.equal(approvalKeys.length, 3, 'one shared approval counter key per principal+family subject');
    const values = (await Promise.all(approvalKeys.map((key) => env.raw.get(key)))).sort();
    assert.deepEqual(values, ['1', '1', '4'], 'each subject counts only its own attempts');
    for (const key of approvalKeys) {
      assert.equal(parseMcpRateLimitKey(key).kind, 'ok', 'the counter key is a canonical mcp codec key');
    }
  }, 60_000);

  test('MCP commit distinct-plan policy: ONE shared budget across instances; exact replay is free, distinct plans charge', async () => {
    const prefix = `rl06-mcp-commit-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-mcp-commit-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildMcpPair(prefix, keySecret, mcpBudgets(10, 10, 2));
    const facts = mcpBindingFacts('principal-1');

    assert.equal(
      (await pair.a.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-1' })).kind,
      'allowed',
    );
    assert.equal(
      (await pair.b.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-2' })).kind,
      'allowed',
    );
    // MRTR retry of the SAME plan on the OTHER instance is FREE (dedup).
    assert.equal(
      (await pair.b.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-1' })).kind,
      'allowed',
      'exact replay of a known plan is free',
    );
    // A third DISTINCT plan is charged and denied across instances.
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-3' })).kind,
      'denied',
      'distinct plans share ONE budget across instances',
    );
    // A DIFFERENT binding owns its own budget.
    assert.equal(
      (await pair.b.limiter.consume({ policy: 'commit-distinct-plan', facts: mcpBindingFacts('principal-2'), distinct: 'plan-3' })).kind,
      'allowed',
      'a different binding stays isolated',
    );
    assert.ok(pair.a.counts.evalshaCalls >= 2 && pair.b.counts.evalshaCalls >= 3,
      'both instances ran commit admission through their OWN clients');

    // One Redis SET per binding holding exactly the DISTINCT plans: the
    // denied plan-3 never occupies a slot and the replay never re-counts.
    const commitKeys = (await env.raw.keys(`${prefix}:*`)).filter((key) => key.includes(':commit-distinct-plan:'));
    assert.equal(commitKeys.length, 2, 'one shared commit set key per binding');
    const cardinals = (await Promise.all(commitKeys.map((key) => env.raw.scard(key)))).sort();
    assert.deepEqual(cardinals, [1, 2], 'the SET holds exactly the distinct plans; dedup and denials never re-count');
    for (const key of commitKeys) {
      assert.equal(parseMcpRateLimitKey(key).kind, 'ok', 'the commit key is a canonical mcp codec key');
      assert.equal(key.includes('plan-'), false, 'plan ids never enter the key text');
    }
  }, 60_000);

  test('MCP three budgets never overlap: exhausting one policy leaves the other two untouched', async () => {
    const prefix = `rl06-mcp-isolation-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-mcp-isolation-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildMcpPair(prefix, keySecret, mcpBudgets(1, 1, 1));
    const facts = mcpBindingFacts('principal-1');
    const listFacts = mcpApprovalFacts(MCP_APPROVAL_LIST_FAMILY, 'principal-1');

    // request exhausted (1 budget) across instances.
    assert.equal((await pair.a.limiter.consume({ policy: 'request', facts })).kind, 'allowed');
    assert.equal((await pair.b.limiter.consume({ policy: 'request', facts })).kind, 'denied', 'request exhausted');
    // approval and commit are NOT affected by the request exhaustion.
    assert.equal((await pair.a.limiter.consume({ policy: 'approval', facts: listFacts })).kind, 'allowed', 'approval unaffected');
    assert.equal((await pair.b.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-1' })).kind, 'allowed', 'commit unaffected');
    // approval exhausted on its own; commit still untouched.
    assert.equal((await pair.b.limiter.consume({ policy: 'approval', facts: listFacts })).kind, 'denied', 'approval exhausted on its own');
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'commit-distinct-plan', facts, distinct: 'plan-2' })).kind,
      'denied',
      'commit distinct-plan exhausted on its own',
    );
    // request stays exhausted (its own counter stayed put).
    assert.equal((await pair.a.limiter.consume({ policy: 'request', facts })).kind, 'denied', 'request stays exhausted');

    // One counter key per named policy; exact counters. Every admission
    // attempt counts into the shared counter, including the trailing
    // "stays exhausted" checks: request = 3 (1 allowed + 2 denied), approval
    // = 2 (1 allowed + 1 denied), commit set = {plan-1} (plan-2 was denied
    // and SREMed, so it never occupies a slot).
    const keys = await env.raw.keys(`${prefix}:*`);
    const policies = new Set<string>();
    for (const key of keys) {
      const parsed = parseMcpRateLimitKey(key);
      assert.equal(parsed.kind, 'ok', 'every run key is a canonical mcp codec key');
      if (parsed.kind === 'ok') policies.add(parsed.parts.policy);
    }
    assert.deepEqual([...policies].sort(), ['approval', 'commit-distinct-plan', 'request'], 'one counter per named policy');
    assert.equal(await env.raw.get(keys.find((key) => key.includes(':request:'))!), '3');
    assert.equal(await env.raw.get(keys.find((key) => key.includes(':approval:'))!), '2');
    const commitKeys = keys.filter((key) => key.includes(':commit-distinct-plan:'));
    assert.equal(commitKeys.length, 1, 'one commit set key');
    assert.equal(await env.raw.scard(commitKeys[0]!), 1, 'the denied plan-2 does not occupy a slot (distinct-plan semantics)');
  }, 60_000);

  test('MCP rate limit: a Redis outage fails closed for all three policies on both instances and recovers', async () => {
    const prefix = `rl06-mcp-outage-${randomUUID()}`;
    const keySecret = Buffer.from(`rl06-mcp-outage-secret-${randomUUID()}`, 'utf8');
    await waitForWindowHeadroom(env.raw, 60_000);
    const pair = await buildMcpPair(prefix, keySecret, mcpBudgets(3, 2, 2));
    const baselineFacts = mcpBindingFacts('principal-1');

    // Baseline: the shared store works before the outage.
    assert.equal((await pair.a.limiter.consume({ policy: 'request', facts: baselineFacts })).kind, 'allowed');

    // Stop the REAL redis-server PROCESS (same containment as the auth
    // outage test); container exec failures are environment failures.
    const shutdown = await env.container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) throw new Error(`redis-cli shutdown failed: ${shutdown.output}`);
    try {
      // BOTH instances fail closed: request/approval surface a FAILED
      // outcome (never a fabricated denial or allowed), and the commit
      // policy denies (fail closed = no commit is admitted).
      for (const instance of [pair.a, pair.b]) {
        const request = await instance.limiter.consume({ policy: 'request', facts: baselineFacts });
        assert.equal(request.kind, 'failed', `request on ${instance.name} must fail closed during the outage`);
        if (request.kind === 'failed') {
          assert.ok(
            ['unavailable', 'timeout', 'malformed', 'acl', 'internal'].includes(request.failure.class),
            'the failure carries a sealed failure class only',
          );
        }
        const approval = await instance.limiter.consume({
          policy: 'approval',
          facts: mcpApprovalFacts(MCP_APPROVAL_LIST_FAMILY, 'principal-1'),
        });
        assert.equal(approval.kind, 'failed', `approval on ${instance.name} must fail closed during the outage`);
        const commit = await instance.limiter.consume({
          policy: 'commit-distinct-plan',
          facts: baselineFacts,
          distinct: 'plan-1',
        });
        assert.equal(commit.kind, 'failed', `commit on ${instance.name} must fail closed during the outage (never allowed)`);
      }
    } finally {
      const restore = await env.container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) throw new Error(`redis-server restart failed: ${restore.output}`);
    }

    // Recovery health barrier (polling, no fixed sleep) with FRESH subjects
    // (the nosave restart may or may not have persisted pre-outage counters):
    // the circuit breaker only transitions through a real store check and
    // the script cache was flushed by the restart (NOSCRIPT reload path).
    const recoveredA = mcpBindingFacts('principal-9');
    await waitUntil(async () => {
      const outcome = await pair.a.limiter.consume({ policy: 'request', facts: recoveredA });
      return outcome.kind === 'allowed';
    }, 20_000, 'mcp rate-limit recovery on instance A', 250);
    assert.equal((await pair.a.limiter.consume({ policy: 'request', facts: recoveredA })).kind, 'allowed', 'budget unit 2');
    assert.equal((await pair.a.limiter.consume({ policy: 'request', facts: recoveredA })).kind, 'allowed', 'budget unit 3');
    assert.equal(
      (await pair.a.limiter.consume({ policy: 'request', facts: recoveredA })).kind,
      'denied',
      'the recovered shared budget is enforced again',
    );

    // Instance B recovers through its OWN client (fresh principal).
    const recoveredB = mcpBindingFacts('principal-8');
    await waitUntil(async () => {
      const outcome = await pair.b.limiter.consume({ policy: 'request', facts: recoveredB });
      return outcome.kind === 'allowed';
    }, 20_000, 'mcp rate-limit recovery on instance B', 250);
  }, 60_000);
});
