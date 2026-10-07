import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  archiveSeries,
  attachEdition,
  createSeries,
  detachEdition,
  publishEdition,
  updateEdition,
  updateSeries,
  withdrawEdition,
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
  assertDirectSeriesPublicationAllowed,
  bearerActorOf,
  etag,
  invalidCursor,
  invalidDocument,
  isInvalidCursor,
  mapReportError,
  mutationActor,
  notFound,
  objectBody,
  param,
  parsePage,
  readAuthorizedEdition,
  readAuthorizedSeries,
  reportEditionPage,
  requireReportPublishGuard,
  sendReportOutcome,
  sessionActor,
  stringField,
  requireReportUnitOfWork,
} from "./report-route-helpers.js";
const BASE = REPORT_ROUTE_PATHS.base;
const ISSUE = REPORT_ROUTE_PATHS.issue;
const ONE = REPORT_ROUTE_PATHS.edition;

async function publishEditionRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ReportRoutesDependencies,
): Promise<unknown> {
  const actor = await mutationActor(request, deps);
  const reportId = param(request, "reportId");
  const editionId = param(request, "editionId");
  const bearer = await bearerActorOf(request);
  if (bearer) requireReportPublishGuard(deps);
  await admit(deps.rateLimiter, `${ONE}/publish`, actor);
  try {
    const command = {
      actor,
      commandId: readKnownCommandId(request),
      editionId,
      seriesId: reportId,
      expectedRevision: readRequiredIfMatch(request),
    };
    const outcome = bearer
      ? await publishEdition(requireReportPublishGuard(deps).reportsUnitOfWorkFor({
        seriesId: reportId,
        editionId,
        accountId: actor.principalId,
        credentialId: bearer.credentialId,
        scopes: bearer.scopes,
      }), command)
      : await publishEdition(requireReportUnitOfWork(deps), command);
    if (outcome.kind !== "succeeded")
      return sendReportOutcome(reply, outcome);
    return reply
      .code(200)
      .header("ETag", etag(outcome.value.resourceRevision))
      .header("Cache-Control", "private, no-store")
      .send(outcome.value);
  } catch (error) {
    throw mapReportError(error);
  }
}

export function registerPrimaryReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): void {
  app.post(
    BASE,
    {
      config: {
        ...productRouteMetadata("POST", BASE),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/json"],
          bodyLimitBytes: 8192,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      await admit(deps.rateLimiter, BASE, actor);
      const body = objectBody(request.body, [
        "title",
        "summary",
        "slug",
        "visibility",
        "allowSearchIndexing",
      ]);
      await assertDirectSeriesPublicationAllowed(request, body.visibility);
      const outcome = await createSeries(requireReportUnitOfWork(deps), {
        actor,
        commandId: readKnownCommandId(request),
        title: stringField(body.title, "title"),
        summary: body.summary as string | null | undefined,
        slug: body.slug as string | null | undefined,
        visibility: body.visibility as never,
        allowSearchIndexing: body.allowSearchIndexing as boolean | undefined,
      });
      if (outcome.kind !== "succeeded")
        return sendReportOutcome(reply, outcome);
      return reply
        .code(201)
        .header("Location", `${BASE}/${outcome.value.id}`)
        .header("ETag", etag(outcome.value.resourceRevision))
        .header("Cache-Control", "private, no-store")
        .type("application/json")
        .send(outcome.value);
    },
  );
  app.get(
    `${BASE}/:reportId`,
    {
      config: {
        ...productRouteMetadata("GET", `${BASE}/:reportId`),
        productTransport: {
          allowedQuery: [],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      const reportId = param(request, "reportId");
      await admit(deps.rateLimiter, `${BASE}/:reportId`, actor);
      const value = await readAuthorizedSeries(deps, reportId, actor);
      // Public/unlisted anonymous data has a separate projection endpoint; this
      // route only returns the authorized private representation.
      if (!value) throw notFound();
      return reply
        .code(200)
        .header("ETag", etag(value.resourceRevision))
        .header("Cache-Control", "private, no-store")
        .send(value);
    },
  );
  app.patch(
    `${BASE}/:reportId`,
    {
      config: {
        ...productRouteMetadata("PATCH", `${BASE}/:reportId`),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/merge-patch+json"],
          bodyLimitBytes: 8192,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      const reportId = param(request, "reportId");
      await admit(deps.rateLimiter, `${BASE}/:reportId`, actor);
      const body = objectBody(request.body, [
        "title",
        "summary",
        "slug",
        "visibility",
        "allowSearchIndexing",
      ]);
      await assertDirectSeriesPublicationAllowed(request, body.visibility);
      const outcome = await updateSeries(requireReportUnitOfWork(deps), {
        actor,
        commandId: readKnownCommandId(request),
        seriesId: reportId,
        expectedRevision: readRequiredIfMatch(request),
        title: body.title as string | undefined,
        summary: body.summary as string | null | undefined,
        slug: body.slug as string | null | undefined,
        visibility: body.visibility as never,
        allowSearchIndexing: body.allowSearchIndexing as boolean | undefined,
      });
      if (outcome.kind !== "succeeded")
        return sendReportOutcome(reply, outcome);
      return reply
        .code(200)
        .header("ETag", etag(outcome.value.resourceRevision))
        .header("Cache-Control", "private, no-store")
        .send(outcome.value);
    },
  );
  app.delete(
    `${BASE}/:reportId`,
    {
      config: {
        ...productRouteMetadata("DELETE", `${BASE}/:reportId`),
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
      const reportId = param(request, "reportId");
      await admit(deps.rateLimiter, `${BASE}/:reportId`, actor);
      const outcome = await archiveSeries(requireReportUnitOfWork(deps), {
        actor,
        commandId: readKnownCommandId(request),
        seriesId: reportId,
        expectedRevision: readRequiredIfMatch(request),
      });
      if (outcome.kind !== "succeeded")
        return sendReportOutcome(reply, outcome);
      return reply.code(204).send();
    },
  );

  app.get(
    ISSUE,
    {
      config: {
        ...productRouteMetadata("GET", ISSUE),
        productTransport: {
          allowedQuery: ["limit", "cursor"],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      const reportId = param(request, "reportId");
      await admit(deps.rateLimiter, ISSUE, actor);
      try {
        const page = await reportEditionPage(
          deps,
          reportId,
          actor,
          parsePage(request.query, deps.config.reports.limits.pageMaxLimit),
        );
        if (!page) throw notFound();
        return reply
          .code(200)
          .header("Cache-Control", "private, no-store")
          .send(page);
      } catch (error) {
        if (isInvalidCursor(error)) throw invalidCursor();
        throw mapReportError(error);
      }
    },
  );
  app.post(
    ISSUE,
    {
      config: {
        ...productRouteMetadata("POST", ISSUE),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/json"],
          bodyLimitBytes: 8192,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      const reportId = param(request, "reportId");
      await admit(deps.rateLimiter, ISSUE, actor);
      const b = objectBody(request.body, [
        "collectionId",
        "issueKey",
        "title",
        "summary",
        "periodStart",
        "periodEnd",
      ]);
      try {
        const outcome = await attachEdition(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          seriesId: reportId,
          sourceCollectionId: stringField(b.collectionId, "collectionId"),
          issueKey: stringField(b.issueKey, "issueKey"),
          titleSnapshot: stringField(b.title, "title"),
          summarySnapshot: b.summary as string | null | undefined,
          periodStart: b.periodStart as string | null | undefined,
          periodEnd: b.periodEnd as string | null | undefined,
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(201)
          .header("Location", `${BASE}/${reportId}/issues/${outcome.value.id}`)
          .header("ETag", etag(outcome.value.resourceRevision))
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.get(
    ONE,
    {
      config: {
        ...productRouteMetadata("GET", ONE),
        productTransport: {
          allowedQuery: [],
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await sessionActor(request, deps);
      const idv = param(request, "editionId");
      await admit(deps.rateLimiter, ONE, actor);
      const value = await readAuthorizedEdition(
        deps,
        param(request, "reportId"),
        idv,
        actor,
      );
      if (!value) throw notFound();
      return reply
        .code(200)
        .header("ETag", etag(value.resourceRevision))
        .header("Cache-Control", "private, no-store")
        .send(value);
    },
  );
  app.patch(
    ONE,
    {
      config: {
        ...productRouteMetadata("PATCH", ONE),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: ["application/merge-patch+json"],
          bodyLimitBytes: 8192,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      const actor = await mutationActor(request, deps);
      const reportId = param(request, "reportId");
      const editionId = param(request, "editionId");
      await admit(deps.rateLimiter, ONE, actor);
      const b = objectBody(request.body, [
        "title",
        "summary",
        "periodStart",
        "periodEnd",
      ]);
      try {
        const outcome = await updateEdition(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          editionId,
          seriesId: reportId,
          expectedRevision: readRequiredIfMatch(request),
          titleSnapshot: b.title as string | undefined,
          summarySnapshot: b.summary as string | null | undefined,
          periodStart: b.periodStart as string | null | undefined,
          periodEnd: b.periodEnd as string | null | undefined,
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(200)
          .header("ETag", etag(outcome.value.resourceRevision))
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.delete(
    ONE,
    {
      config: {
        ...productRouteMetadata("DELETE", ONE),
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
      const reportId = param(request, "reportId");
      const editionId = param(request, "editionId");
      await admit(deps.rateLimiter, ONE, actor);
      try {
        const outcome = await detachEdition(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          editionId,
          seriesId: reportId,
          expectedRevision: readRequiredIfMatch(request),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(204)
          .header("Cache-Control", "private, no-store")
          .send();
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
  app.post(
    `${ONE}/publish`,
    {
      config: {
        ...productRouteMetadata("POST", `${ONE}/publish`),
        productTransport: {
          allowedQuery: [],
          acceptedMediaTypes: [],
          bodyLimitBytes: 1,
          cacheControl: "private-no-store",
        },
      },
    },
    async (request, reply) => {
      return publishEditionRoute(request, reply, deps);
    },
  );
  app.post(
    `${ONE}/withdraw`,
    {
      config: {
        ...productRouteMetadata("POST", `${ONE}/withdraw`),
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
      const reportId = param(request, "reportId");
      const editionId = param(request, "editionId");
      await admit(deps.rateLimiter, `${ONE}/withdraw`, actor);
      try {
        const outcome = await withdrawEdition(requireReportUnitOfWork(deps), {
          actor,
          commandId: readKnownCommandId(request),
          editionId,
          seriesId: reportId,
          expectedRevision: readRequiredIfMatch(request),
        });
        if (outcome.kind !== "succeeded")
          return sendReportOutcome(reply, outcome);
        return reply
          .code(200)
          .header("ETag", etag(outcome.value.resourceRevision))
          .header("Cache-Control", "private, no-store")
          .send(outcome.value);
      } catch (error) {
        throw mapReportError(error);
      }
    },
  );
}
