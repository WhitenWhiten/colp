import type { AppConfig } from "../../bootstrap/config.js";
import type { IdentityUnitOfWork } from "../../modules/identity/index.js";
import type { ReportPublishGuard, ReportUnitOfWork } from "../../modules/reports/index.js";
import type { ReportCacheReader } from "../../infrastructure/reports/report-cache.js";
import type { SearchRateLimiter } from "../../infrastructure/rate-limit/index.js";
import type { ProductAdmissionRateLimiter } from "../http-security.js";

export const REPORT_ROUTE_PATHS = Object.freeze({
  base: "/api/v1/reports",
  issue: "/api/v1/reports/:reportId/issues",
  edition: "/api/v1/reports/:reportId/issues/:editionId",
  member: "/api/v1/reports/:reportId/members/:subjectId",
  publicBase: "/api/v1/public-reports",
});

export interface ReportRoutesDependencies {
  readonly config: AppConfig;
  readonly identityUnitOfWork?: IdentityUnitOfWork;
  readonly unitOfWork?: ReportUnitOfWork;
  /** Private report admission (`reports` purpose). */
  readonly rateLimiter?: ProductAdmissionRateLimiter;
  /** Public report admission; shared with Explore/Directory anonymous traffic. */
  readonly publicRateLimiter?: SearchRateLimiter;
  readonly reportCache?: ReportCacheReader;
  /**
   * Bearer-only gate for the report publish route (reports:publish scope AND
   * a valid grant/Plan approval). Browser Cookie publication keeps the manual
   * interactive flow. When it is absent and a bearer tries to publish, the
   * route fails closed with 403 — never silently publishing without the gate.
   */
  readonly reportPublishGuard?: ReportPublishGuard;
  /** Explicit composition facts used to keep declared routes fail-closed. */
  readonly privateDependenciesReady?: boolean;
  readonly publicDependenciesReady?: boolean;
}

export function isPublicReportRoute(routePath: string | undefined): boolean {
  return (
    routePath === REPORT_ROUTE_PATHS.publicBase ||
    routePath?.startsWith(`${REPORT_ROUTE_PATHS.publicBase}/`) === true
  );
}

export function isPrivateReportRoute(routePath: string | undefined): boolean {
  if (routePath === undefined) return false;
  return (
    routePath === REPORT_ROUTE_PATHS.base ||
    routePath.startsWith(`${REPORT_ROUTE_PATHS.base}/`) ||
    routePath === "/api/v1/me/reports" ||
    routePath === "/api/v1/me/followed-reports" ||
    routePath === "/api/v1/me/followed-reports/issues"
  );
}

export function privateDependenciesReady(
  deps: ReportRoutesDependencies,
): boolean {
  return (
    deps.privateDependenciesReady ??
    (deps.identityUnitOfWork !== undefined &&
      deps.unitOfWork !== undefined &&
      deps.rateLimiter !== undefined)
  );
}

export function publicDependenciesReady(
  deps: ReportRoutesDependencies,
): boolean {
  return (
    deps.publicDependenciesReady ??
    (deps.unitOfWork !== undefined && deps.publicRateLimiter !== undefined)
  );
}
