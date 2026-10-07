import { readSubscriptionExitPreview } from './subscription-exit-header.js';
import type { FastifyInstance } from "fastify";
import type { ReportActor } from "../../modules/reports/index.js";
import {
  deleteDigestSchedule,
  followSeries,
  getReportFollowState,
  listFollowedReportIssues,
  listFollowedReports,
  listOwnedReports,
  revokeMember,
  unfollowSeries,
  upsertDigestSchedule,
  upsertMember,
} from "../../modules/reports/index.js";
import {
  readKnownCommandId,
  readRequiredIfMatch,
} from "./collection-route-helpers.js";
import { productRouteMetadata } from "../product-route-manifest.js";
import type { ReportRoutesDependencies } from "./report-route-contract.js";
import { REPORT_ROUTE_PATHS } from "./report-route-contract.js";
import {
  admit,
  cursorConfig,
  etag,
  invalidCursor,
  isInvalidCursor,
  mapReportError,
  mutationActor,
  notFound,
  objectBody,
  param,
  parsePage,
  readAuthorizedMembers,
  readAuthorizedSchedule,
  requireReportUnitOfWork,
  sendReportOutcome,
  sessionActor,
  stringField,
} from "./report-route-helpers.js";
const BASE = REPORT_ROUTE_PATHS.base;
const MEMBER = REPORT_ROUTE_PATHS.member;
const SCHEDULE = BASE + "/:reportId/schedule";
const FOLLOW = BASE + "/:reportId/follow";
const MY = "/api/v1/me/reports";
export function registerSecondaryReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  app.get(
    `${BASE}/:reportId/members`,
    {
      config: {
        ...productRouteMetadata("GET", `${BASE}/:reportId/members`),
        productTransport: {
          allowedQuery: [],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      const idv = param(request, "reportId");
      await admit(deps.rateLimiter, `${BASE}/:reportId/members`, actor);
      const items = await readAuthorizedMembers(deps, idv, actor);
      if (!items) throw notFound();
      return reply
        .code(200)
        .header("Cache-Control", "private, no-store")
        .send({ items, nextCursor: null });
    },
  );
  app.put(
    MEMBER,
    {
      config: {
        ...productRouteMetadata("PUT", MEMBER),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/json"],
          bodyLimitBytes: 1024,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, MEMBER, actor);
      const b = objectBody(request.body, ["role"]);
      const seriesId = param(request, "reportId");
      try {
        const outcome = await upsertMember(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          seriesId,
          subjectId: param(request, "subjectId"),
          role: b.role as "editor" | "viewer",
          expectedPolicyRevision: readRequiredIfMatch(request),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        if (outcome.response)
          Object.entries(outcome.response.stableHeaders).forEach(
            ([name, value]) => reply.header(name, value),
          );
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.delete(
    MEMBER,
    {
      config: {
        ...productRouteMetadata("DELETE", MEMBER),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, MEMBER, actor);
      try {
        const outcome = await revokeMember(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          seriesId: param(request, "reportId"),
          subjectId: param(request, "subjectId"),
          expectedPolicyRevision: readRequiredIfMatch(request),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply.code(204).send();
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );

  app.get(
    SCHEDULE,
    {
      config: {
        ...productRouteMetadata("GET", SCHEDULE),
        productTransport: {
          allowedQuery: [],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      const idv = param(request, "reportId");
      await admit(deps.rateLimiter, SCHEDULE, actor);
      const schedule = await readAuthorizedSchedule(deps, idv, actor);
      if (schedule === undefined) throw notFound();
      return reply
        .code(200)
        .header("Cache-Control", "private, no-store")
        .send({ schedule });
    },
  );
  app.put(
    SCHEDULE,
    {
      config: {
        ...productRouteMetadata("PUT", SCHEDULE),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/json"],
          bodyLimitBytes: 4096,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, SCHEDULE, actor);
      const body = objectBody(request.body, [
        "rrule",
        "dtstart",
        "timeZone",
        "catchUpPolicy",
        "maxCatchUp",
      ]);
      try {
        const outcome = await upsertDigestSchedule(
          requireReportUnitOfWork(deps),
          {
            actor,
            commandId: readKnownCommandId(request),
            seriesId: param(request, "reportId"),
            expectedRevision: request.headers["if-match"] as string | undefined,
            schedule: {
              rrule: stringField(body.rrule, "rrule"),
              dtstart: stringField(body.dtstart, "dtstart"),
              timeZone: stringField(body.timeZone, "timeZone"),
              catchUpPolicy: body.catchUpPolicy as "skip" | "one" | undefined,
              maxCatchUp: body.maxCatchUp as number | undefined,
            },
          },
        );
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(200)
          .header("ETag", etag(outcome.value.resourceRevision))
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.delete(
    SCHEDULE,
    {
      config: {
        ...productRouteMetadata("DELETE", SCHEDULE),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, SCHEDULE, actor);
      try {
        const outcome = await deleteDigestSchedule(
          requireReportUnitOfWork(deps),
          {
            actor,
            commandId: readKnownCommandId(request),
            seriesId: param(request, "reportId"),
            expectedRevision: request.headers["if-match"] as string | undefined,
          },
        );
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply.code(204).send();
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );

  app.get(
    FOLLOW,
    {
      config: {
        ...productRouteMetadata("GET", FOLLOW),
        productTransport: {
          allowedQuery: [],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      await admit(deps.rateLimiter, FOLLOW, actor);
      const value = await getReportFollowState(
        requireReportUnitOfWork(deps),
        param(request, "reportId"),
        actor,
      );
      if (!value) throw notFound();
      return reply
        .code(200)
        .header("Cache-Control", "private, no-store")
        .send(value);
    },
  );
  app.put(
    FOLLOW,
    {
      config: {
        ...productRouteMetadata("PUT", FOLLOW),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, FOLLOW, actor);
      try {
        const outcome = await followSeries(requireReportUnitOfWork(deps), {
          actor: actor as ReportActor & { profileId: string },
          commandId: readKnownCommandId(request),
          seriesId: param(request, "reportId"),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.delete(
    FOLLOW,
    {
      config: {
        ...productRouteMetadata("DELETE", FOLLOW),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps, reply);
      await admit(deps.rateLimiter, FOLLOW, actor);
      try {
        const outcome = await unfollowSeries(requireReportUnitOfWork(deps), {
          ...readSubscriptionExitPreview(request),
          actor: actor as ReportActor & { profileId: string },
          commandId: readKnownCommandId(request),
          seriesId: param(request, "reportId"),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );

  app.get(
    MY,
    {
      config: {
        ...productRouteMetadata("GET", MY),
        productTransport: {
          allowedQuery: ["limit", "cursor"],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      await admit(deps.rateLimiter, MY, actor);
      const q = parsePage(
        request.query,
        deps.config.reports.limits.pageMaxLimit,
      );
      try {
        const page = await listOwnedReports(
          requireReportUnitOfWork(deps),
          actor.subjectId,
          cursorConfig(deps),
          q.limit,
          q.cursor,
        );
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(page);
      } catch (error) {
        if (isInvalidCursor(error)) throw invalidCursor();
        throw error;
      }
    },
  );
  app.get(
    "/api/v1/me/followed-reports",
    {
      config: {
        ...productRouteMetadata("GET", "/api/v1/me/followed-reports"),
        productTransport: {
          allowedQuery: ["limit", "cursor"],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      await admit(deps.rateLimiter, "/api/v1/me/followed-reports", actor);
      const q = parsePage(
        request.query,
        deps.config.reports.limits.pageMaxLimit,
      );
      try {
        const page = await listFollowedReports(
          requireReportUnitOfWork(deps),
          actor.profileId!,
          cursorConfig(deps),
          q.limit,
          q.cursor,
        );
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(page);
      } catch (error) {
        if (isInvalidCursor(error)) throw invalidCursor();
        throw error;
      }
    },
  );
  app.get(
    "/api/v1/me/followed-reports/issues",
    {
      config: {
        ...productRouteMetadata("GET", "/api/v1/me/followed-reports/issues"),
        productTransport: {
          allowedQuery: ["limit", "cursor"],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      await admit(
        deps.rateLimiter,
        "/api/v1/me/followed-reports/issues",
        actor,
      );
      const q = parsePage(
        request.query,
        deps.config.reports.limits.pageMaxLimit,
      );
      try {
        const page = await listFollowedReportIssues(
          requireReportUnitOfWork(deps),
          actor.profileId!,
          cursorConfig(deps),
          q.limit,
          q.cursor,
        );
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(page);
      } catch (error) {
        if (isInvalidCursor(error)) throw invalidCursor();
        throw error;
      }
    },
  );
}
