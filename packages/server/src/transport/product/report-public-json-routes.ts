import type { FastifyInstance } from "fastify";
import {
  getPublicReportIssue,
  getPublicReportSeries,
  listPublicReportDirectory,
  listPublicReportIssues,
} from "../../modules/reports/index.js";
import { parseLanguageQuery } from "../../modules/governance/index.js";
import { productRouteMetadata } from "../product-route-manifest.js";
import type { ReportRoutesDependencies } from "./report-route-contract.js";
import { REPORT_ROUTE_PATHS } from "./report-route-contract.js";
import {
  admitPublic,
  cursorConfig,
  invalidCursor,
  invalidDocument,
  isInvalidCursor,
  mapReportError,
  notFound,
  opaqueParam,
  parsePage,
  publicParam,
  requireReportUnitOfWork,
} from "./report-route-helpers.js";
import { ProductHttpError } from "../product-error.js";

const PUBLIC_BASE = REPORT_ROUTE_PATHS.publicBase;

export function registerPublicReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  const publicConfig = (path: string, allowedQuery: string[] = []) => ({
    exposeHeadRoute: false,
    config: {
      ...productRouteMetadata("GET", path),
      productTransport: {
        allowedQuery,
        cacheControl: "public-revalidate" as const,
        duplicateQueryErrorCode: "invalid_query" as const,
      },
    },
  });
  app.get(
    PUBLIC_BASE,
    publicConfig(PUBLIC_BASE, deps.config.contentGovernance.enabled ? ["limit", "cursor", "language"] : ["limit", "cursor"]),
    async (request, reply) => {
      if (!deps.config.reports.publicEnabled) throw notFound();
      await admitPublic(deps.publicRateLimiter, request);
      const q = parsePage(
        request.query,
        deps.config.reports.limits.pageMaxLimit,
        deps.config.contentGovernance.enabled ? ["language"] : [],
      );
      const limit = q.limit ?? 50;
      let language: string | undefined;
      if (deps.config.contentGovernance.enabled) {
        const raw = (request.query as { language?: unknown }).language;
        if (raw !== undefined) {
          try {
            language = parseLanguageQuery(raw);
          } catch {
            throw new ProductHttpError({
              statusCode: 400,
              code: "invalid_query",
              message: "The public report language is invalid.",
            });
          }
        }
      }
      let page;
      try {
        const unitOfWork = requireReportUnitOfWork(deps);
        const config = cursorConfig(deps);
        const boundLanguage = deps.config.contentGovernance.enabled ? language ?? null : undefined;
        page = deps.reportCache
          ? await deps.reportCache.directory(
              unitOfWork,
              config,
              limit,
              q.cursor,
              undefined,
              boundLanguage,
            )
          : await listPublicReportDirectory(
              unitOfWork,
              config,
              limit,
              q.cursor,
              boundLanguage,
            );
      } catch (error) {
        if (isInvalidCursor(error))
          throw new ProductHttpError({
            statusCode: 400,
            code: "invalid_cursor",
            message: "The public report cursor is invalid.",
            recovery: "restart_from_first_page",
          });
        throw error;
      }
      return reply
        .code(200)
        .header("Cache-Control", deps.config.contentGovernance.enabled
          ? "public, max-age=0, must-revalidate"
          : "public, max-age=30, must-revalidate")
        .header("Vary", "Accept, Accept-Encoding")
        .send(page);
    },
  );
  app.get(
    `${PUBLIC_BASE}/:slug`,
    publicConfig(`${PUBLIC_BASE}/:slug`),
    async (request, reply) => {
      if (!deps.config.reports.publicEnabled) throw notFound();
      await admitPublic(deps.publicRateLimiter, request);
      const slug = publicParam(request, "slug");
      const unitOfWork = requireReportUnitOfWork(deps);
      const value = deps.reportCache
        ? await deps.reportCache.series(unitOfWork, slug)
        : await getPublicReportSeries(unitOfWork, slug);
      if (!value) throw notFound();
      return reply
        .code(200)
        .header("Cache-Control", deps.config.contentGovernance.enabled
          ? "public, max-age=0, must-revalidate"
          : "public, max-age=30, must-revalidate")
        .header("Vary", "Accept, Accept-Encoding")
        .header("X-Robots-Tag", value.indexable ? "index, follow" : "noindex")
        .send(value);
    },
  );
  app.get(
    `${PUBLIC_BASE}/:slug/issues`,
    publicConfig(`${PUBLIC_BASE}/:slug/issues`, ["limit", "cursor"]),
    async (request, reply) => {
      if (!deps.config.reports.publicEnabled) throw notFound();
      await admitPublic(deps.publicRateLimiter, request);
      const slug = publicParam(request, "slug");
      const q = parsePage(
        request.query,
        deps.config.reports.limits.pageMaxLimit,
      );
      try {
        const page = await listPublicReportIssues(
          requireReportUnitOfWork(deps),
          slug,
          cursorConfig(deps),
          q.limit,
          q.cursor,
        );
        if (!page) throw notFound();
        return reply
          .code(200)
          .header("Cache-Control", deps.config.contentGovernance.enabled
            ? "public, max-age=0, must-revalidate"
            : "public, max-age=30, must-revalidate")
          .header("Vary", "Accept, Accept-Encoding")
          .send(page);
      } catch (error) {
        if (isInvalidCursor(error)) throw invalidCursor();
        throw mapReportError(error);
      }
    },
  );
  app.get(
    `${PUBLIC_BASE}/:slug/issues/:editionId`,
    publicConfig(`${PUBLIC_BASE}/:slug/issues/:editionId`),
    async (request, reply) => {
      if (!deps.config.reports.publicEnabled) throw notFound();
      await admitPublic(deps.publicRateLimiter, request);
      const slug = publicParam(request, "slug");
      const editionId = opaqueParam(request, "editionId");
      const unitOfWork = requireReportUnitOfWork(deps);
      const value = deps.reportCache
        ? await deps.reportCache.issue(unitOfWork, slug, editionId)
        : await getPublicReportIssue(unitOfWork, slug, editionId);
      if (!value) throw notFound();
      return reply
        .code(200)
        .header("Cache-Control", deps.config.contentGovernance.enabled
          ? "public, max-age=0, must-revalidate"
          : "public, max-age=30, must-revalidate")
        .header("Vary", "Accept, Accept-Encoding")
        .header(
          "X-Robots-Tag",
          value.series.indexable ? "index, follow" : "noindex",
        )
        .send(value.issue);
    },
  );
}
