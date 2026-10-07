import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../bootstrap/config.js";
import type {
  PublicReportIssue,
  PublicReportSeries,
  ReportUnitOfWork,
} from "../../modules/reports/index.js";
import {
  assertCanonicalReportSlug,
  getPublicReportIssue,
  getPublicReportSeries,
  listPublicReportDirectory,
} from "../../modules/reports/index.js";
import type { SearchRateLimiter } from "../../infrastructure/rate-limit/index.js";
import {
  buildPublicReportMarkdown,
  buildPublicReportMarkdownNotFound,
  buildReportsSitemapUrlset,
  injectPublicReportShell,
  ReportSitemapLimitError,
  type PublicReportShellIssue,
  type PublicReportShellSeries,
  type WebShellCache,
  wantsPublicShellMarkdown,
} from "../../infrastructure/http/index.js";
import type { ReportCacheReader } from "../../infrastructure/reports/report-cache.js";
import {
  sendPublicationProblem,
  sendPublicationRateLimitProblem,
} from "./publication-snapshot-routes.js";
import {
  abortPublicationRead,
  requestCancellation,
} from "./publication-request-cancel.js";
import {
  createFixedWindowRateLimiter,
  rateLimitClientKey,
} from "../http-security.js";
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from "./explore-directory-rate-limit.js";
import {
  applyPublicShellHeaders,
  applyPublicShellLastModified,
  sendPublicShellBody,
  sendPublicShellMarkdownBody,
} from "../public-shell-routes.js";

export interface PublicReportShellRouteDeps {
  readonly config: AppConfig;
  readonly unitOfWork?: ReportUnitOfWork;
  readonly reportCache?: ReportCacheReader;
  readonly publicShell?: { readonly cache: WebShellCache };
  readonly rateLimiter?: SearchRateLimiter;
  /** Composition fact used to keep enabled-but-incomplete surfaces fail-closed. */
  readonly publicDependenciesReady?: boolean;
  /** Governed mode revalidates controlled HTML/XML at the edge on every request. */
  readonly contentGovernanceEnabled?: boolean;
}

interface ReportPathParams {
  readonly slug?: unknown;
  readonly editionId?: unknown;
}

interface ReportCursorConfig {
  readonly active: { readonly id: string; readonly secret: string };
  readonly retained?: readonly {
    readonly id: string;
    readonly secret: string;
    readonly lastIssuedAt: string;
    readonly retainUntil: string;
  }[];
}

export function registerPublicReportShellRoutes(
  app: FastifyInstance,
  deps: PublicReportShellRouteDeps,
): void {
  registerReportsSitemapRoute(app, deps);
  app.route({
    method: ["GET", "HEAD"],
    url: "/reports",
    handler: (request, reply) => respond(request, reply, deps),
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/reports/:slug",
    handler: (request, reply) => respond(request, reply, deps),
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/reports/:slug/issues/:editionId",
    handler: (request, reply) => respondIssue(request, reply, deps),
  });
}

function registerReportsSitemapRoute(
  app: FastifyInstance,
  deps: PublicReportShellRouteDeps,
): void {
  app.route({
    method: ["GET", "HEAD"],
    url: "/sitemap-reports.xml",
    handler: async (request, reply) => {
      const cancellation = requestCancellation(request, reply);
      try {
        if (!deps.config.reports.publicEnabled) {
          return sendSitemapNotFound(reply, request);
        }
        if (!shellDependenciesReady(deps)) {
          return sendUnavailable(reply, request);
        }
        await admitExploreDirectoryRateLimit(
          deps.rateLimiter,
          exploreDirectoryAnonymousSubject(request),
          "Too many sitemap requests. Please try again later.",
        );
        const items = await loadSitemapSeries(deps, cancellation.signal);
        return sendSitemap(reply, request, buildReportsSitemapUrlset(items), deps.contentGovernanceEnabled === true);
      } catch (error: unknown) {
        const limited = sendPublicationRateLimitProblem(reply, request, error);
        if (limited !== undefined) return limited;
        if (cancellation.signal.aborted) return abortPublicationRead(reply);
        if (isSitemapUnavailable(error)) {
          reply.header("Retry-After", "1");
          return sendPublicationProblem(reply, request.method, {
            code: "service_unavailable",
          });
        }
        throw error;
      } finally {
        cancellation.dispose();
      }
    },
  });
}

async function respond(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: PublicReportShellRouteDeps,
): Promise<FastifyReply> {
  const markdown = wantsPublicShellMarkdown(
    typeof request.headers.accept === "string"
      ? request.headers.accept
      : undefined,
  );
  const cancellation = requestCancellation(request, reply);
  try {
    if (!deps.config.reports.publicEnabled) {
      return sendClosedReportNotFound(reply, request, markdown, deps);
    }
    if (!shellDependenciesReady(deps)) {
      return sendUnavailable(reply, request);
    }
    await admitExploreDirectoryRateLimit(
      deps.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      "Too many report requests. Please try again later.",
    );
    const shell = markdown
      ? undefined
      : await loadShell(deps, cancellation.signal, reply, request);
    if (!markdown && shell === null) return reply;

    const { slug } = request.params as ReportPathParams;
    if (slug === undefined) {
      const page = await loadDirectory(deps, cancellation.signal);
      const rows = page.items
        .map(mapSeries)
        .filter((item): item is PublicReportShellSeries => item !== null);
      applyPublicShellLastModified(
        reply,
        newest(rows.map((item) => item.updatedAt)),
      );
      const body = buildPublicReportMarkdown(null, rows);
      return markdown
        ? sendPublicShellMarkdownBody(reply, request.method, 200, body, deps.contentGovernanceEnabled === true)
        : sendHtml(reply, request, injectPublicReportShell(shell!, null, rows), true, deps.contentGovernanceEnabled === true);
    }

    if (typeof slug !== "string") return notFound(reply, request, markdown, deps, true);
    try {
      assertCanonicalReportSlug(slug);
    } catch {
      return notFound(reply, request, markdown, deps, true);
    }
    const value = deps.reportCache
      ? await deps.reportCache.series(
          requireReportUnitOfWork(deps),
          slug,
          cancellation.signal,
        )
      : await getPublicReportSeries(requireReportUnitOfWork(deps), slug);
    const series = mapSeries(value);
    if (!series) return notFound(reply, request, markdown, deps, true);

    applyPublicShellLastModified(reply, series.updatedAt);
    const body = buildPublicReportMarkdown(series);
    return markdown
      ? sendPublicShellMarkdownBody(reply, request.method, 200, body, deps.contentGovernanceEnabled === true)
      : sendHtml(
          reply,
          request,
          injectPublicReportShell(shell!, series),
          series.indexable,
          deps.contentGovernanceEnabled === true,
        );
  } catch (error: unknown) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

async function respondIssue(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: PublicReportShellRouteDeps,
): Promise<FastifyReply> {
  const markdown = wantsPublicShellMarkdown(
    typeof request.headers.accept === "string"
      ? request.headers.accept
      : undefined,
  );
  const cancellation = requestCancellation(request, reply);
  try {
    if (!deps.config.reports.publicEnabled) {
      return sendClosedReportNotFound(reply, request, markdown, deps);
    }
    if (!shellDependenciesReady(deps)) {
      return sendUnavailable(reply, request);
    }
    await admitExploreDirectoryRateLimit(
      deps.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      "Too many report requests. Please try again later.",
    );
    const shell = markdown
      ? undefined
      : await loadShell(deps, cancellation.signal, reply, request);
    if (!markdown && shell === null) return reply;

    const params = request.params as ReportPathParams;
    if (
      typeof params.slug !== "string" ||
      typeof params.editionId !== "string" ||
      !/^[A-Za-z0-9._~-]{1,128}$/u.test(params.editionId)
    ) {
      return notFound(reply, request, markdown, deps, true);
    }
    try {
      assertCanonicalReportSlug(params.slug);
    } catch {
      return notFound(reply, request, markdown, deps, true);
    }

    const value = deps.reportCache
      ? await deps.reportCache.issue(
          requireReportUnitOfWork(deps),
          params.slug,
          params.editionId,
          cancellation.signal,
        )
      : await getPublicReportIssue(
          requireReportUnitOfWork(deps),
          params.slug,
          params.editionId,
        );
    if (!value) return notFound(reply, request, markdown, deps, true);

    const series = {
      ...mapSeries(value.series)!,
      issues: [mapIssue(value.issue, value.series.slug)],
    };
    // The issue is a live source reference: source edits can change the
    // representation without changing the original publish instant. Use the
    // series projection fence so Last-Modified tracks those changes.
    applyPublicShellLastModified(reply, value.series.updatedAt);
    const canonicalPath = `/reports/${encodeURIComponent(params.slug)}/issues/${encodeURIComponent(value.issue.id)}`;
    const body = buildPublicReportMarkdown(series);
    return markdown
      ? sendPublicShellMarkdownBody(reply, request.method, 200, body, deps.contentGovernanceEnabled === true)
      : sendHtml(
          reply,
          request,
          injectPublicReportShell(shell!, series, [], { canonicalPath }),
          series.indexable,
          deps.contentGovernanceEnabled === true,
        );
  } catch (error: unknown) {
    const limited = sendPublicationRateLimitProblem(reply, request, error);
    if (limited !== undefined) return limited;
    if (cancellation.signal.aborted) return abortPublicationRead(reply);
    throw error;
  } finally {
    cancellation.dispose();
  }
}

async function loadDirectory(
  deps: PublicReportShellRouteDeps,
  signal: AbortSignal,
): Promise<{ readonly items: readonly PublicReportSeries[] }> {
  const config = cursorConfig(deps);
  const unitOfWork = requireReportUnitOfWork(deps);
  return deps.reportCache
    ? deps.reportCache.directory(unitOfWork, config, 50, undefined, signal)
    : listPublicReportDirectory(unitOfWork, config, 50);
}

function shellDependenciesReady(deps: PublicReportShellRouteDeps): boolean {
  return (
    deps.publicDependenciesReady ??
    (deps.unitOfWork !== undefined && deps.rateLimiter !== undefined)
  );
}

function requireReportUnitOfWork(
  deps: PublicReportShellRouteDeps,
): ReportUnitOfWork {
  if (deps.unitOfWork === undefined) {
    throw new Error("reports persistence is unavailable");
  }
  return deps.unitOfWork;
}

function mapIssue(
  issue: PublicReportIssue,
  slug: string,
): PublicReportShellIssue {
  return {
    ...issue,
    // A hide_public tombstone has no reachable issue page: no dead link.
    url: issue.state === 'hidden'
      ? null
      : `/reports/${encodeURIComponent(slug)}/issues/${encodeURIComponent(issue.id)}`,
  };
}

function mapSeries(
  value: PublicReportSeries | null,
): PublicReportShellSeries | null {
  if (!value) return null;
  return {
    ...value,
    issues: value.issues.map((issue) => mapIssue(issue, value.slug)),
  };
}

function cursorConfig(deps: PublicReportShellRouteDeps): ReportCursorConfig {
  return {
    active: {
      id: deps.config.reports.cursor.active.id,
      secret: deps.config.reports.cursor.active.secret,
    },
    retained: deps.config.reports.cursor.retained,
  };
}

function newest(values: readonly string[]): string | undefined {
  const timestamps = values.map(Date.parse).filter(Number.isFinite);
  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : undefined;
}

async function loadShell(
  deps: PublicReportShellRouteDeps,
  signal: AbortSignal,
  reply: FastifyReply,
  request: FastifyRequest,
): Promise<string | null> {
  if (!deps.publicShell) {
    reply.header("Retry-After", "1");
    sendPublicationProblem(reply, request.method, {
      code: "service_unavailable",
    });
    return null;
  }
  const loaded = await deps.publicShell.cache.load(signal);
  if (loaded.kind === "unavailable" || !loaded.body) {
    reply.header("Retry-After", "1");
    sendPublicationProblem(reply, request.method, {
      code: "service_unavailable",
    });
    return null;
  }
  return loaded.body;
}

/**
 * Feature-off HTML shell reads. cache.load may fetch the shell origin, so
 * that read uses this per-IP ceiling plus the web-shell cache timeout.
 * It is not the anonymous Explore quota. A spent ceiling still returns 404.
 */
const CLOSED_REPORT_SHELL_ORIGIN_BUDGET = "closed-report-shell-origin";
const CLOSED_REPORT_SHELL_ORIGIN_MAX_LOADS = 30;
const closedReportShellOriginLimiter = createFixedWindowRateLimiter({
  maxRequests: CLOSED_REPORT_SHELL_ORIGIN_MAX_LOADS,
  windowMs: 60_000,
});
const CLOSED_REPORT_HTML_FALLBACK =
  "<!doctype html><html><head><title>Digest not found — Know-N</title></head><body><h1>Digest not found</h1></body></html>";

async function notFound(
  reply: FastifyReply,
  request: FastifyRequest,
  markdown: boolean,
  deps: PublicReportShellRouteDeps,
  alreadyLimited = false,
): Promise<FastifyReply> {
  // Enabled unknown HTML still admits Explore before the shell origin.
  if (!markdown && !alreadyLimited && deps.publicShell) {
    await admitExploreDirectoryRateLimit(
      deps.rateLimiter,
      exploreDirectoryAnonymousSubject(request),
      "Too many report requests. Please try again later.",
    );
  }
  const shell = markdown ? undefined : await readReportShell(deps);
  return writeReportNotFound(reply, request, markdown, deps, shell);
}

async function sendClosedReportNotFound(
  reply: FastifyReply,
  request: FastifyRequest,
  markdown: boolean,
  deps: PublicReportShellRouteDeps,
): Promise<FastifyReply> {
  const shell = markdown ? undefined : await readClosedReportShell(request, deps);
  return writeReportNotFound(reply, request, markdown, deps, shell);
}

async function readReportShell(
  deps: PublicReportShellRouteDeps,
): Promise<string | undefined> {
  const loaded = await deps.publicShell?.cache.load();
  return loaded?.kind === "ok" && loaded.body ? loaded.body : undefined;
}

async function readClosedReportShell(
  request: FastifyRequest,
  deps: PublicReportShellRouteDeps,
): Promise<string | undefined> {
  if (!deps.publicShell) return undefined;
  const admission = closedReportShellOriginLimiter.consume(
    rateLimitClientKey(request, CLOSED_REPORT_SHELL_ORIGIN_BUDGET),
  );
  if (!admission.allowed) return undefined;
  return readReportShell(deps);
}

async function writeReportNotFound(
  reply: FastifyReply,
  request: FastifyRequest,
  markdown: boolean,
  deps: PublicReportShellRouteDeps,
  shell: string | undefined,
): Promise<FastifyReply> {
  const governed = deps.contentGovernanceEnabled === true;
  if (markdown) {
    applyPublicShellHeaders(reply, "text/markdown; charset=utf-8", governed);
    return sendPublicShellBody(
      reply,
      request.method,
      404,
      buildPublicReportMarkdownNotFound(),
    );
  }
  // R15-24: the hydratable shell renders the app's styled not-found page.
  applyPublicShellHeaders(reply, undefined, governed);
  return sendPublicShellBody(
    reply,
    request.method,
    404,
    shell ?? CLOSED_REPORT_HTML_FALLBACK,
  );
}

function sendHtml(
  reply: FastifyReply,
  request: FastifyRequest,
  body: string,
  indexable = true,
  governed = false,
): FastifyReply {
  applyPublicShellHeaders(reply, undefined, governed);
  if (!indexable) reply.header("X-Robots-Tag", "noindex, nofollow");
  return sendPublicShellBody(reply, request.method, 200, body);
}

function sendSitemap(
  reply: FastifyReply,
  request: FastifyRequest,
  body: string,
  governed = false,
): FastifyReply {
  const buffer = Buffer.from(body, "utf8");
  reply
    .code(200)
    .header("Content-Type", "application/xml; charset=utf-8")
    .header("Cache-Control", "public, max-age=0, must-revalidate")
    .header("Vary", "Accept-Encoding")
    .header("Content-Length", String(buffer.byteLength));
  // Governed mode drops the CDN freshness override so the edge revalidates.
  if (!governed) reply.header("Cloudflare-CDN-Cache-Control", "max-age=60");
  return request.method === "HEAD" ? reply.send() : reply.send(buffer);
}

function sendSitemapNotFound(
  reply: FastifyReply,
  request: FastifyRequest,
): FastifyReply {
  const body = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<error>Not found</error>\n',
    "utf8",
  );
  reply
    .code(404)
    .header("Content-Type", "application/xml; charset=utf-8")
    .header("Cache-Control", "private, no-store")
    .header("Content-Length", String(body.byteLength));
  return request.method === "HEAD" ? reply.send() : reply.send(body);
}

function sendUnavailable(
  reply: FastifyReply,
  request: FastifyRequest,
): FastifyReply {
  reply.header("Retry-After", "1");
  return sendPublicationProblem(reply, request.method, {
    code: "service_unavailable",
  });
}

function isSitemapUnavailable(error: unknown): boolean {
  return (
    error instanceof ReportSitemapLimitError ||
    (error instanceof Error &&
      /report_(directory|projection)_limit_exceeded|invalid_cursor/u.test(
        error.message,
      ))
  );
}

/** Read the complete bounded sitemap input without silently truncating pages. */
async function loadSitemapSeries(
  deps: PublicReportShellRouteDeps,
  signal: AbortSignal,
): Promise<readonly PublicReportShellSeries[]> {
  const pageSize = 100;
  const maxPages = 501; // 2,000 series authority cap + one defensive page.
  const rows: PublicReportShellSeries[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    signal.throwIfAborted();
    const page = deps.reportCache
      ? await deps.reportCache.directory(
          requireReportUnitOfWork(deps),
          cursorConfig(deps),
          pageSize,
          cursor,
          signal,
        )
      : await listPublicReportDirectory(
          requireReportUnitOfWork(deps),
          cursorConfig(deps),
          pageSize,
          cursor,
        );
    rows.push(
      ...page.items
        .map(mapSeries)
        .filter((item): item is PublicReportShellSeries => item !== null),
    );
    if (page.nextCursor === null) return rows;
    if (page.nextCursor === cursor) throw new Error("invalid_cursor");
    cursor = page.nextCursor;
  }
  throw new ReportSitemapLimitError();
}
