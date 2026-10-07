import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExplorePageReadPort } from '../modules/publication/index.js';
import type { SearchRateLimiter } from '../infrastructure/rate-limit/index.js';
import {
  buildPublicExploreMarkdown,
  injectPublicExploreShell,
  PUBLIC_EXPLORE_ITEM_LIMIT,
  PUBLIC_EXPLORE_PATH,
  wantsPublicShellMarkdown,
  type PublicExploreShellItem,
  type WebShellCache,
} from '../infrastructure/http/index.js';
import { sendPublicationProblem, sendPublicationRateLimitProblem } from './product/publication-snapshot-routes.js';
import { abortPublicationRead, requestCancellation } from './product/publication-request-cancel.js';
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from './product/explore-directory-rate-limit.js';
import {
  applyPublicShellHeaders,
  applyPublicShellLastModified,
  newestInstant,
  sendPublicShellBody,
  sendPublicShellMarkdownBody,
} from './public-shell-routes.js';

export const PUBLIC_EXPLORE_ROUTE = PUBLIC_EXPLORE_PATH;

export interface PublicExploreShellRoutePorts {
  readonly cache: WebShellCache;
}

/**
 * Origin-injected `/explore` document: the newest public collections as real
 * `/c/:slug` links plus the page's own title / description / canonical, so
 * crawlers that do not execute JavaScript stop seeing the home-page head on
 * the discovery hub. Always on: the listing is the same public data as
 * `/sitemap-collections.xml`. This surface never 404s; any failure is a
 * problem response that nginx replaces with the static SPA shell.
 */
export function registerPublicExploreShellRoutes(
  app: FastifyInstance,
  dependencies: {
    readonly page: ExplorePageReadPort;
    readonly publicShell?: PublicExploreShellRoutePorts;
    readonly rateLimiter?: SearchRateLimiter;
    /** Governed mode revalidates controlled HTML at the edge on every request. */
    readonly contentGovernanceEnabled?: boolean;
  },
): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: PUBLIC_EXPLORE_ROUTE,
    handler: async (request, reply) => respondWithPublicExploreShell(request, reply, dependencies),
  });
}

async function respondWithPublicExploreShell(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly page: ExplorePageReadPort;
    readonly publicShell?: PublicExploreShellRoutePorts;
    readonly rateLimiter?: SearchRateLimiter;
    readonly contentGovernanceEnabled?: boolean;
  },
): Promise<FastifyReply> {
  const cancellation = requestCancellation(request, reply);
  try {
    await admitExploreDirectoryRateLimit(
      input.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      'Too many Explore requests. Please try again later.',
    );
    const markdown = wantsPublicShellMarkdown(singleAccept(request));
    let shell: string | undefined;
    if (!markdown) {
      if (input.publicShell === undefined) {
        reply.header('Retry-After', '1');
        return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
      }
      const loaded = await input.publicShell.cache.load(cancellation.signal);
      if (loaded.kind === 'unavailable' || loaded.body === undefined) {
        reply.header('Retry-After', '1');
        return sendPublicationProblem(reply, request.method, { code: 'service_unavailable' });
      }
      shell = loaded.body;
    }
    const records = await input.page.loadPage({
      filter: {},
      sort: 'updated',
      limit: PUBLIC_EXPLORE_ITEM_LIMIT,
      signal: cancellation.signal,
    });
    const items: PublicExploreShellItem[] = records.map((record) => ({
      slug: record.publicationSlug,
      title: record.title,
      summary: record.summary,
      nodeCount: record.nodeCount,
      updatedAt: record.updatedAt,
    }));
    applyPublicShellLastModified(reply, newestInstant(items.map((item) => item.updatedAt)));
    const governed = input.contentGovernanceEnabled === true;
    if (markdown) {
      return sendPublicShellMarkdownBody(reply, request.method, 200, buildPublicExploreMarkdown(items), governed);
    }
    applyPublicShellHeaders(reply, undefined, governed);
    return sendPublicShellBody(reply, request.method, 200, injectPublicExploreShell(shell!, items));
  } catch (error) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

function singleAccept(request: FastifyRequest): string | undefined {
  const accept = request.headers.accept;
  return typeof accept === 'string' ? accept : undefined;
}
