import type { FastifyInstance } from "fastify";
import type { ReportRoutesDependencies } from "./report-route-contract.js";
import {
  isPrivateReportRoute,
  isPublicReportRoute,
  privateDependenciesReady,
  publicDependenciesReady,
} from "./report-route-contract.js";
import { registerPrivateReportRoutes } from "./report-private-routes.js";
import { registerPublicReportRoutes } from "./report-public-json-routes.js";
import { notFound, unavailable } from "./report-route-helpers.js";
export { registerPublicReportShellRoutes } from "./report-public-shell-routes.js";
export type { ReportRoutesDependencies } from "./report-route-contract.js";

/**
 * Registers the complete report transport surface.  The route declarations
 * stay mounted when a feature is disabled so the product manifest remains
 * stable; the hook below performs the side-effect-free 404/503 gate before
 * auth, rate-limit or persistence work.
 */
export function registerReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  app.addHook("onRequest", async (request) => {
    const routePath = request.routeOptions.url;
    if (isPrivateReportRoute(routePath)) {
      if (!deps.config.reports.enabled) throw notFound();
      if (!privateDependenciesReady(deps)) throw unavailable();
    }
    if (isPublicReportRoute(routePath)) {
      if (!deps.config.reports.publicEnabled) throw notFound();
      if (!publicDependenciesReady(deps)) throw unavailable();
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      isPrivateReportRoute(request.routeOptions.url) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      reply.getHeader("Cache-Control") === undefined
    ) {
      reply.header("Cache-Control", "private, no-store");
    }
    return payload;
  });

  registerPublicReportRoutes(app, deps);
  registerPrivateReportRoutes(app, deps);
}
