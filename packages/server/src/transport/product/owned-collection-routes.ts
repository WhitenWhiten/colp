import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  OwnedCollectionsCursorError,
  OwnedCollectionsInputError,
  bookmarkCountFor,
  getOwnedCollectionsPage,
  lookupCollectionBookmarkCounts,
  toOwnedCollectionListItem,
  type OwnedCollectionFact,
} from '../../modules/collections/index.js';
import { negotiatePublicationRead } from './publication-read-negotiation.js';
import type { CollectionRoutesDeps } from './collection-route-helpers.js';
import { productErrorStatus } from '../product-codes.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireSessionActor } from '../session-auth.js';

const ROUTE = '/api/v1/collections';
const KINDS = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);
const VISIBILITIES = new Set(['private', 'protected', 'unlisted', 'public']);

export function registerOwnedCollectionRoutes(app: FastifyInstance, deps: CollectionRoutesDeps): void {
  if (!deps.ownedCollectionsQuery) return;
  if (!deps.bookmarkCounts) {
    throw new Error('owned Collection list requires CollectionBookmarkCountReadPort');
  }
  const bookmarkCounts = deps.bookmarkCounts;
  app.get(ROUTE, { config: {
    ...productRouteMetadata('GET', ROUTE),
    productTransport: { allowedQuery: ['kind', 'visibility', 'limit', 'cursor'],
      duplicateQueryErrorCode: 'invalid_query', cacheControl: 'private-no-store' },
  } }, async (request, reply) => {
    const { account } = await requireOwnedCollectionActor(request, deps);
    negotiateAccept(request.headers.accept);
    const query = parseOwnedQuery(request);
    try {
      const page = await getOwnedCollectionsPage(deps.ownedCollectionsQuery!, {
        actor: { subjectId: account.subjectId }, ...query,
      });
      const counts = await lookupCollectionBookmarkCounts(bookmarkCounts, page.items);
      return reply.code(200).type('application/json; charset=utf-8').send({
        items: page.items.map((row) => ({
          ...toOwnedCollectionListItem(row, {
            principalId: account.id, subjectId: account.subjectId,
          }),
          bookmarkCount: bookmarkCountFor(counts, row.id),
        })), page: page.page,
      });
    } catch (error: unknown) {
      if (error instanceof OwnedCollectionsCursorError) throw invalidCursor();
      if (error instanceof OwnedCollectionsInputError) throw invalidQuery();
      throw error;
    }
  });
}

async function requireOwnedCollectionActor(
  request: FastifyRequest,
  deps: CollectionRoutesDeps,
): Promise<{ readonly account: { readonly id: string; readonly subjectId: string } }> {
  return requireSessionActor(request, deps.identityUnitOfWork, { touch: false });
}

function parseOwnedQuery(request: FastifyRequest): {
  readonly kind?: OwnedCollectionFact['kind']; readonly visibility?: OwnedCollectionFact['visibility'];
  readonly limit?: number; readonly cursor?: string;
} {
  const query = request.query as Record<string, string>;
  assertCanonicalRawQuery(request.raw.url ?? request.url, query);
  const present = (name: string) => Object.hasOwn(query, name);
  if (present('cursor')) {
    if (present('kind') || present('visibility') || present('limit')) throw invalidQuery();
    if (typeof query.cursor !== 'string' || query.cursor.length < 1) throw invalidQuery();
    return { cursor: query.cursor };
  }
  const result: { kind?: OwnedCollectionFact['kind']; visibility?: OwnedCollectionFact['visibility']; limit?: number } = {};
  if (present('kind')) {
    if (typeof query.kind !== 'string' || !KINDS.has(query.kind)) throw invalidQuery();
    result.kind = query.kind as OwnedCollectionFact['kind'];
  }
  if (present('visibility')) {
    if (typeof query.visibility !== 'string' || !VISIBILITIES.has(query.visibility)) throw invalidQuery();
    result.visibility = query.visibility as OwnedCollectionFact['visibility'];
  }
  if (present('limit')) {
    if (typeof query.limit !== 'string' || !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(query.limit)) throw invalidQuery();
    result.limit = Number(query.limit);
  }
  return result;
}

function assertCanonicalRawQuery(url: string, parsed: Record<string, string>): void {
  const marker = url.indexOf('?');
  if (marker < 0) return;
  const raw = url.slice(marker + 1);
  if (raw.length === 0) throw invalidQuery();
  const canonicalOrder = ['kind', 'visibility', 'limit', 'cursor'];
  let previousIndex = -1;
  const seen = new Set<string>();
  for (const entry of raw.split('&')) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw invalidQuery();
    const rawName = entry.slice(0, separator); const rawValue = entry.slice(separator + 1);
    let name: string; let value: string;
    try { name = decodeURIComponent(rawName); value = decodeURIComponent(rawValue); }
    catch { throw invalidQuery(); }
    const orderIndex = canonicalOrder.indexOf(name);
    if (orderIndex < 0 || orderIndex <= previousIndex || seen.has(name)
      || rawName !== encodeURIComponent(name) || rawValue !== encodeURIComponent(value)
      || parsed[name] !== value) throw invalidQuery();
    seen.add(name);
    previousIndex = orderIndex;
  }
}

function negotiateAccept(value: string | readonly string[] | undefined): void {
  const accept = typeof value === 'string' ? value : value === undefined ? undefined : '';
  if (accept !== undefined && accept.trim() === '') throw notAcceptable();
  if (!negotiatePublicationRead({ accept, protocolVersion: undefined,
    mediaType: 'application/json', version: '1.8.0' })) throw notAcceptable();
}
function invalidQuery() { return new ProductHttpError({ statusCode: 400, code: 'invalid_query', message: 'The owned Collection query is invalid.' }); }
function invalidCursor() { return new ProductHttpError({ statusCode: 400, code: 'invalid_cursor', message: 'The owned Collection cursor is invalid.', recovery: 'restart_from_first_page' }); }
function notAcceptable() { return new ProductHttpError({ statusCode: productErrorStatus('not_acceptable'), code: 'not_acceptable', message: 'No acceptable owned Collection representation is available.' }); }
