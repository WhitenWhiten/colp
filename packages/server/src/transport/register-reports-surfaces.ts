import type { FastifyInstance } from "fastify";
import type { ProductSurfaceRateLimitPurpose } from "../infrastructure/rate-limit/index.js";
import {
  createFixedWindowRateLimiter,
  type ProductAdmissionRateLimiter,
} from "./http-security.js";
import type { AppDependencies } from "./app-dependencies.js";
import {
  registerPublicReportShellRoutes,
  registerReportRoutes,
} from "./product/report-routes.js";
import { registerReportCatalogRoutes } from "./product/catalog-routes.js";
import type { ReportUnitOfWork } from "../modules/reports/index.js";
import { ReportsApplicationError } from "../modules/reports/index.js";

type ResolveRateLimiter = (
  purpose: ProductSurfaceRateLimitPurpose,
  limiter: ProductAdmissionRateLimiter | undefined,
  budget: { readonly maxRequests: number; readonly windowMs: number },
) => ProductAdmissionRateLimiter;

/** Register report Product/API and public-shell surfaces in one bounded seam. */
export function registerReportsProductSurfaces(
  app: FastifyInstance,
  deps: AppDependencies,
  options: {
    readonly resolveRateLimiter: ResolveRateLimiter;
    readonly requireExploreDirectoryLimiter: () => NonNullable<
      AppDependencies["exploreDirectoryRateLimiter"]
    >;
    readonly exploreDirectoryRateLimiter?: AppDependencies["exploreDirectoryRateLimiter"];
    readonly defaultBudget: {
      readonly maxRequests: number;
      readonly windowMs: number;
    };
  },
): void {
  const {
    config,
    identityUnitOfWork,
    reportsUnitOfWork,
    reportCache,
    reportsRateLimiter,
    publicShell,
  } = deps;
  // Keep all report routes mounted even when optional production adapters are
  // absent.  The transport gate then returns a deterministic 503 (or 404 when
  // the feature flag is off) instead of silently changing the product
  // manifest or throwing while the application is being composed.
  const unavailableUnitOfWork: ReportUnitOfWork = {
    execute: async () => {
      throw new ReportsApplicationError(
        "dependency_unavailable",
        "Reports persistence is unavailable.",
      );
    },
  };
  let rateLimiter: ProductAdmissionRateLimiter;
  let privateRateLimiterReady = true;
  try {
    rateLimiter = options.resolveRateLimiter(
      "reports",
      reportsRateLimiter,
      options.defaultBudget,
    );
  } catch {
    rateLimiter = createFixedWindowRateLimiter(options.defaultBudget);
    privateRateLimiterReady = false;
  }
  const unitOfWork = reportsUnitOfWork ?? unavailableUnitOfWork;
  const privateDependenciesReady =
    identityUnitOfWork !== undefined &&
    reportsUnitOfWork !== undefined &&
    privateRateLimiterReady;
  const publicDependenciesReady =
    reportsUnitOfWork !== undefined &&
    options.exploreDirectoryRateLimiter !== undefined;
  const originReportCache = config.contentGovernance.enabled
    ? undefined
    : reportCache;
  const reportDeps = {
    config,
    identityUnitOfWork,
    unitOfWork,
    rateLimiter,
    publicRateLimiter: options.exploreDirectoryRateLimiter,
    privateDependenciesReady,
    publicDependenciesReady,
    ...(originReportCache === undefined ? {} : { reportCache: originReportCache }),
    ...(deps.reportPublishGuard === undefined ? {} : { reportPublishGuard: deps.reportPublishGuard }),
  };
  registerReportRoutes(app, reportDeps);
  registerReportCatalogRoutes(app, reportDeps);
  registerPublicReportShellRoutes(app, {
    config,
    unitOfWork,
    ...(originReportCache === undefined ? {} : { reportCache: originReportCache }),
    ...(publicShell === undefined ? {} : { publicShell }),
    // A disabled public shell must not force an Explore/Directory dependency
    // just to register its stable 404 route.  Once the public surface is on,
    // use the shared directory limiter as required by the public contract.
    rateLimiter: options.exploreDirectoryRateLimiter,
    publicDependenciesReady,
    contentGovernanceEnabled: config.contentGovernance.enabled,
  });
}
