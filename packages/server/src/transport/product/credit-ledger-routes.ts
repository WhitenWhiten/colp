import { compareCreditInstants, validCreditInstant } from './credit-ledger-time.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import {
  CLASSIFICATION_CREDIT_PRICE,
  CREDIT_LEDGER_CURSOR_TTL_MS,
  type CreditLedgerFilters,
  type CreditLedgerReadPageFacts,
  type CreditLedgerReadPort,
  type CreditLedgerCursorPayload,
} from '../../modules/identity/index.js';
import { CreditError } from '../../modules/identity/index.js';
import { requireBrowserSessionActor } from '../session-auth.js';
import { ProductHttpError } from '../product-error.js';
import { CreditHttpError, sendCreditHttpError } from './credit-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import type { KeyedCursorCodec } from '../../modules/commands/index.js';

const OVERVIEW = '/api/v1/me/credits';
const LEDGER = '/api/v1/me/credits/ledger';
const ENTRY = `${LEDGER}/:entryId`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const KINDS = new Set(['grant', 'reserve', 'spend', 'release', 'expire', 'refund', 'topup', 'payment_refund']);
const OPAQUE_ID_MAX_BYTES = 128;

export interface CreditLedgerRoutesDependencies {
  readonly creditEnabled: boolean;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly reads: CreditLedgerReadPort;
  readonly cursor: KeyedCursorCodec<CreditLedgerCursorPayload>;
  readonly rateLimiter: ProductAdmissionRateLimiter;
}

export function registerCreditLedgerRoutes(app: FastifyInstance, deps: CreditLedgerRoutesDependencies): void {
  const metadata = (method: 'GET', path: string, allowedQuery: readonly string[]) => ({
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata(method, path),
      productTransport: {
        allowedQuery,
        duplicateQueryErrorCode: 'invalid_request' as const,
        cacheControl: 'private-no-store' as const, rejectRequestBody: true,
      },
    },
  });

  app.get(OVERVIEW, metadata('GET', OVERVIEW, ['includeBillingMode']), async (request, reply) => withCreditErrors(request, reply, async () => {
    const account = await actor(request, deps);
    await admission(account.id, deps.rateLimiter);
    const includeBillingMode = (request.query as Record<string, unknown>).includeBillingMode;
    if (includeBillingMode !== undefined && includeBillingMode !== 'true' && includeBillingMode !== 'false') throw invalidRequest();
    const result = await deps.reads.readLatest(account.id, {}, 1);
    if (result.kind === 'reconciling') return throwReconciling();
    if (result.page.accountId !== account.id) {
      throw new CreditHttpError(503, 'credits_unavailable', 'Credits could not be confirmed. Retry the same request.', 'same_request', true);
    }
    return reply.type('application/json').send({
      contractVersion: '1.0.0', accountId: account.id, asOf: result.page.snapshot.asOf,
      ...(includeBillingMode === 'true' ? { managedClassificationBillingMode: deps.creditEnabled ? 'managed' : 'legacy_free' } : {}),
      ledgerSequence: result.page.snapshot.ledgerSequence, balance: result.page.snapshot.balance,
      prices: [{ operationType: CLASSIFICATION_CREDIT_PRICE.operationType,
        priceVersion: CLASSIFICATION_CREDIT_PRICE.priceVersion, unit: 'bookmark',
        unitPoints: CLASSIFICATION_CREDIT_PRICE.unitPoints }],
    });
  }));

  app.get(LEDGER, metadata('GET', LEDGER, ['limit', 'cursor', 'kind', 'from', 'to', 'chargeId', 'runId']), async (request, reply) => withCreditErrors(request, reply, async () => {
    const account = await actor(request, deps);
    await admission(account.id, deps.rateLimiter);
    const parsed = parseQuery(request);
    if (parsed.cursor) {
      const cursor = verifyCursor(parsed.cursor, account.id, deps);
      const filters = cursorFilters(cursor);
      const page = await deps.reads.readPage(account.id, {
        filters, limit: cursor.limit, highSequence: cursor.highSequence,
        beforeSequence: cursor.beforeSequence, snapshot: {
          asOf: cursor.asOf, ledgerSequence: cursor.highSequence, balance: cursor.balance,
        },
      });
      const nextCursor = page.hasMore
        ? signCursor(account.id, page.snapshot, page.items.at(-1)?.sequence,
          filters, cursor.limit, deps, cursor)
        : null;
      return reply.type('application/json').send(toPage(account.id, page, nextCursor));
    }
    const result = await deps.reads.readLatest(account.id, parsed.filters, parsed.limit);
    if (result.kind === 'reconciling') return throwReconciling();
    const nextCursor = result.page.hasMore
      ? signCursor(account.id, result.page.snapshot, result.page.items.at(-1)?.sequence, parsed.filters, parsed.limit, deps)
      : null;
    return reply.type('application/json').send(toPage(account.id, result.page, nextCursor));
  }));

  app.get(ENTRY, {
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata('GET', ENTRY),
      productTransport: { allowedQuery: [], cacheControl: 'private-no-store' as const, rejectRequestBody: true },
    },
  }, async (request, reply) => withCreditErrors(request, reply, async () => {
    const account = await actor(request, deps);
    await admission(account.id, deps.rateLimiter);
    const entryId = (request.params as { readonly entryId?: unknown }).entryId;
    if (typeof entryId !== 'string' || !UUID.test(entryId)) throw invalidRequest();
    const entry = await deps.reads.readEntry(account.id, entryId);
    if (!entry) throw new ProductHttpError({ statusCode: 404, code: 'resource_not_found', message: 'Ledger entry not found.', recovery: 'user_action' });
    return reply.type('application/json').send({ contractVersion: '1.0.0', entry });
  }));
}

async function withCreditErrors(
  request: FastifyRequest,
  reply: import('fastify').FastifyReply,
  work: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CreditHttpError) return sendCreditHttpError(request, reply, error);
    if (error instanceof CreditError) {
      const retry = error.code === 'credits_busy' || error.code === 'credits_reconciling' || error.code === 'credits_unavailable';
      const code = retry ? error.code : 'credits_unavailable';
      return sendCreditHttpError(request, reply, new CreditHttpError(
        503, code, 'Credits could not be confirmed. Retry the same request.', 'same_request', true,
      ));
    }
    throw error;
  }
}

async function actor(request: FastifyRequest, deps: CreditLedgerRoutesDependencies) {
  const session = await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch: false });
  return session.account;
}

async function admission(accountId: string, limiter: ProductAdmissionRateLimiter): Promise<void> {
  const result = await consumeProductAdmission(limiter, `credits-read:${accountId}`);
  if (result.kind === 'failed') throw new CreditHttpError(503, 'credits_unavailable', 'Credits are temporarily unavailable.', 'same_request', true);
  if (result.kind === 'denied') throw new ProductHttpError({ statusCode: 429, code: 'rate_limited', message: 'Credit reads are rate limited.', recovery: 'same_request', sameRequestRetrySafe: true, retryAfterSeconds: result.retryAfterSeconds, headers: { 'Retry-After': String(result.retryAfterSeconds) } });
}

function parseQuery(request: FastifyRequest): { readonly limit: number; readonly filters: CreditLedgerFilters; readonly cursor?: string } {
  const query = request.query as Record<string, unknown>;
  const keys = Object.keys(query);
  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (keys.length !== 1 || typeof cursor !== 'string' || cursor.length < 1 || Buffer.byteLength(cursor) > 4096) throw invalidRequest('invalid_cursor');
    return { limit: 20, filters: {}, cursor };
  }
  const limit = query.limit === undefined ? 20 : parseDecimal(query.limit, 1, 100);
  const kind = query.kind === undefined ? undefined : stringValue(query.kind);
  if (kind !== undefined && !KINDS.has(kind)) throw invalidRequest();
  const from = query.from === undefined ? undefined : parseInstant(query.from);
  const to = query.to === undefined ? undefined : parseInstant(query.to);
  if (from && to && compareCreditInstants(from, to) >= 0) throw invalidRequest();
  const chargeId = query.chargeId === undefined ? undefined : canonicalUuid(query.chargeId);
  const runId = query.runId === undefined ? undefined : opaqueId(query.runId);
  return { limit, filters: { ...(kind ? { kind: kind as CreditLedgerFilters['kind'] } : {}), from, to, chargeId, runId } };
}

function parseDecimal(value: unknown, min: number, max: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) throw invalidRequest();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalidRequest();
  return parsed;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidRequest();
  return value;
}

function parseInstant(value: unknown): string {
  const text = stringValue(value);
  if (!validCreditInstant(text)) throw invalidRequest();
  return text;
}

function canonicalUuid(value: unknown): string {
  const text = stringValue(value);
  if (!UUID.test(text)) throw invalidRequest();
  return text;
}

function opaqueId(value: unknown): string {
  const text = stringValue(value);
  if (Buffer.byteLength(text) > OPAQUE_ID_MAX_BYTES || !OPAQUE_ID.test(text)) throw invalidRequest();
  return text;
}

function verifyCursor(token: string, accountId: string, deps: CreditLedgerRoutesDependencies): CreditLedgerCursorPayload {
  let decoded: CreditLedgerCursorPayload;
  try { decoded = deps.cursor.verify(token, new Date()); } catch { throw invalidRequest('invalid_cursor'); }
  cursorFilters(decoded);
  const issuedAt = Date.parse(decoded.issuedAt);
  const expiresAt = Date.parse(decoded.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || decoded.accountId !== accountId || expiresAt <= now
    || issuedAt > now || expiresAt - issuedAt !== CREDIT_LEDGER_CURSOR_TTL_MS) {
    if (decoded.accountId === accountId && Number.isFinite(expiresAt) && expiresAt <= now
      && Number.isFinite(issuedAt) && expiresAt - issuedAt === CREDIT_LEDGER_CURSOR_TTL_MS) throw cursorExpired();
    throw new CreditHttpError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
  return decoded;
}

function cursorFilters(cursor: CreditLedgerCursorPayload): CreditLedgerFilters {
  try {
    return filtersFromRecord(cursor.filters);
  } catch {
    throw new CreditHttpError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
}

function signCursor(accountId: string, snapshot: CreditLedgerReadPageFacts['snapshot'], beforeSequence: string | undefined, filters: CreditLedgerFilters, limit: number, deps: CreditLedgerRoutesDependencies, lifetime?: Pick<CreditLedgerCursorPayload, 'issuedAt' | 'expiresAt'>): string | null {
  if (!beforeSequence) return null;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CREDIT_LEDGER_CURSOR_TTL_MS);
  return deps.cursor.sign({ version: 1, accountId, filters: filterRecord(filters), limit,
    asOf: snapshot.asOf, highSequence: snapshot.ledgerSequence, balance: snapshot.balance,
    beforeSequence, issuedAt: lifetime?.issuedAt ?? issuedAt.toISOString(), expiresAt: lifetime?.expiresAt ?? expiresAt.toISOString() });
}

function filterRecord(filters: CreditLedgerFilters): Record<string, string | null> {
  return { kind: filters.kind ?? null, from: filters.from ?? null, to: filters.to ?? null, chargeId: filters.chargeId ?? null, runId: filters.runId ?? null };
}

function filtersFromRecord(filters: Readonly<Record<string, string | null>>): CreditLedgerFilters {
  const kind = filters.kind === null ? undefined : filters.kind;
  if (kind !== undefined && !KINDS.has(kind)) throw new CreditHttpError(400, 'invalid_cursor', 'The cursor is invalid.');
  const from = filters.from === null ? undefined : parseInstant(filters.from);
  const to = filters.to === null ? undefined : parseInstant(filters.to);
  if (from && to && compareCreditInstants(from, to) >= 0) throw new CreditHttpError(400, 'invalid_cursor', 'The cursor is invalid.');
  const chargeId = filters.chargeId === null ? undefined : canonicalUuid(filters.chargeId);
  const runId = filters.runId === null ? undefined : opaqueId(filters.runId);
  return { ...(kind ? { kind: kind as CreditLedgerFilters['kind'] } : {}), from, to, chargeId, runId };
}

function toPage(accountId: string, page: CreditLedgerReadPageFacts, nextCursor: string | null) {
  if (page.accountId !== accountId) {
    throw new CreditHttpError(503, 'credits_unavailable', 'Credits could not be confirmed. Retry the same request.', 'same_request', true);
  }
  return { contractVersion: '1.0.0', accountId: page.accountId, snapshot: page.snapshot, items: page.items, nextCursor };
}

function invalidRequest(code = 'invalid_request'): ProductHttpError | CreditHttpError {
  if (code === 'invalid_cursor') return new CreditHttpError(400, 'invalid_cursor', 'The cursor is invalid.');
  return new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'The request is invalid.' });
}

function cursorExpired(): CreditHttpError {
  return new CreditHttpError(410, 'cursor_expired', 'The ledger cursor expired.', 'restart_from_first_page', false);
}

function throwReconciling(): never {
  throw new CreditHttpError(503, 'credits_reconciling', 'Credits are being reconciled. Retry the same request.', 'same_request', true);
}
