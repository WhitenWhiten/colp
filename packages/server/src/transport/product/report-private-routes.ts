import type { FastifyInstance } from "fastify";
import type { ReportRoutesDependencies } from "./report-route-contract.js";
import { registerPrimaryReportRoutes } from "./report-private-primary-routes.js";
import { registerSecondaryReportRoutes } from "./report-private-secondary-routes.js";

/** Register the authenticated report API in two bounded route groups. */
export function registerPrivateReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  registerPrimaryReportRoutes(app, deps);
  registerSecondaryReportRoutes(app, deps);
}
