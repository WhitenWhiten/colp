import { prepareSubscriptionExitSession } from './subscription-exit-header.js';
import { BookmarkSubscriptionError } from '../../modules/bookmark-subscriptions/index.js';
import { mapSubscriptionError } from './bookmark-subscription-routes.js';
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  ReportActor,
  ReportUnitOfWork,
  ReportMutationResult,
} from "../../modules/reports/index.js";
import {
  assertCanonicalReportSlug,
  ReportsApplicationError,
  ReportsDomainError,
  createReportsIssueCursorPayload,
  createReportsIssueCursorSigner,
} from "../../modules/reports/index.js";
import type { IdentityUnitOfWork } from "../../modules/identity/index.js";
import type { SearchRateLimiter } from "../../infrastructure/rate-limit/index.js";
import type { ProductAdmissionRateLimiter } from "../http-security.js";
import { consumeProductAdmission } from "../http-security.js";
import {
  admitExploreDirectoryRateLimit,
  exploreDirectoryAnonymousSubject,
} from "./explore-directory-rate-limit.js";
import { requireMutationActor } from "../mutation-actor.js";
import { requireSessionActor } from "../session-auth.js";
import { productBearerActorOf } from "../product-actor.js";
import { AccountCredentialCommandError } from "../../modules/auth/index.js";
import { sendProductCommandReceiptOutcome } from "../product-command-mapping.js";
import { ProductHttpError } from "../product-error.js";
import { productErrorStatus } from "../product-codes.js";
import type { ReportRoutesDependencies } from "./report-route-contract.js";

export function requireReportUnitOfWork(
  deps: ReportRoutesDependencies,
): ReportUnitOfWork {
  if (deps.unitOfWork === undefined) throw unavailable();
  return deps.unitOfWork;
}

export function requireIdentityUnitOfWork(
  deps: ReportRoutesDependencies,
): IdentityUnitOfWork {
  if (deps.identityUnitOfWork === undefined) throw unavailable();
  return deps.identityUnitOfWork;
}

export function publicParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    value.includes("%")
  )
    throw notFound();
  try {
    return assertCanonicalReportSlug(value);
  } catch {
    throw notFound();
  }
}

export function opaqueParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value))
    throw notFound();
  return value;
}

function assertReportsEnabled(deps: ReportRoutesDependencies): void {
  // Keep the feature-off path side-effect free: no session touch and no report
  // transaction should occur merely because a declared route was matched.
  if (!deps.config.reports.enabled) throw notFound();
}
export async function sessionActor(
  request: FastifyRequest,
  deps: ReportRoutesDependencies,
): Promise<ReportActor> {
  assertReportsEnabled(deps);
  const identityUnitOfWork = requireIdentityUnitOfWork(deps);
  const { account } = await requireSessionActor(request, identityUnitOfWork, {
    touch: false,
  });
  return {
    principalId: account.id,
    subjectId: account.subjectId,
    profileId: account.id,
  };
}

export async function mutationActor(
  request: FastifyRequest,
  deps: ReportRoutesDependencies,
  reply?:FastifyReply,
): Promise<ReportActor> {
  assertReportsEnabled(deps);
  const identityUnitOfWork = requireIdentityUnitOfWork(deps);
  if(reply)await prepareSubscriptionExitSession(request,reply,identityUnitOfWork);
  const identity = await requireMutationActor(request, {
    identityUnitOfWork,
    allowedOrigins: deps.config.allowedOrigins,
  });
  const {account}=identity;
  if(reply&&request.headers['known-subscription-exit-preview']!==undefined&&'session'in identity)reply.header('Known-Subscription-Session',identity.session.id);
  return {
    principalId: account.id,
    subjectId: account.subjectId,
    profileId: account.id,
  };
}
export async function readAuthorizedSeries(
  deps: ReportRoutesDependencies,
  seriesId: string,
  actor: ReportActor,
): Promise<import("../../modules/reports/index.js").DigestSeries | null> {
  return requireReportUnitOfWork(deps).execute(async (ports) => {
    const series = await ports.series.lockById(seriesId);
    if (!series || series.state === "archived") return null;
    if (series.ownerSubjectId === actor.subjectId) return series;
    const member = await ports.members.get(series.id, actor.subjectId);
    return member && !member.revokedAt ? series : null;
  });
}

export async function readAuthorizedEdition(
  deps: ReportRoutesDependencies,
  seriesId: string,
  editionId: string,
  actor: ReportActor,
): Promise<import("../../modules/reports/index.js").DigestEdition | null> {
  return requireReportUnitOfWork(deps).execute(async (ports) => {
    const edition = await ports.editions.lockById(editionId);
    if (!edition || edition.seriesId !== seriesId) return null;
    const series = await ports.series.lockById(seriesId);
    if (!series || series.state === "archived") return null;
    if (series.ownerSubjectId === actor.subjectId) return edition;
    const member = await ports.members.get(series.id, actor.subjectId);
    return member && !member.revokedAt ? edition : null;
  });
}

export async function readAuthorizedMembers(
  deps: ReportRoutesDependencies,
  seriesId: string,
  actor: ReportActor,
): Promise<
  readonly import("../../modules/reports/index.js").DigestMember[] | null
> {
  return requireReportUnitOfWork(deps).execute(async (ports) => {
    const series = await ports.series.lockById(seriesId);
    if (!series || series.state === "archived") return null;
    if (series.ownerSubjectId !== actor.subjectId) {
      const member = await ports.members.get(series.id, actor.subjectId);
      if (!member || member.revokedAt || member.role !== "editor") return null;
    }
    const rows = ports.members.list
      ? await ports.members.list(series.id, 101)
      : [];
    return rows.length > 100
      ? (() => {
          throw unavailable();
        })()
      : rows;
  });
}

export async function readAuthorizedSchedule(
  deps: ReportRoutesDependencies,
  seriesId: string,
  actor: ReportActor,
): Promise<
  import("../../modules/reports/index.js").DigestSchedule | null | undefined
> {
  return requireReportUnitOfWork(deps).execute(async (ports) => {
    const series = await ports.series.lockById(seriesId);
    if (!series || series.state === "archived") return undefined;
    // Schedule metadata is private operational configuration.  ND-11 makes
    // the owner the sole reader as well as the sole writer; membership must
    // not disclose RRULE, timezone or catch-up policy.
    if (series.ownerSubjectId !== actor.subjectId) return undefined;
    return ports.schedules?.get(series.id) ?? null;
  });
}
export async function admit(
  limiter: ProductAdmissionRateLimiter | undefined,
  path: string,
  actor: ReportActor,
) {
  if (limiter === undefined) throw unavailable();
  const d = await consumeProductAdmission(
    limiter,
    `${path}:principal:${actor.principalId}`,
  );
  if (d.kind === "failed") throw unavailable();
  if (d.kind === "denied")
    throw new ProductHttpError({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many report requests.",
      recovery: "same_request",
      sameRequestRetrySafe: true,
      retryAfterSeconds: d.retryAfterSeconds,
      headers: { "Retry-After": String(d.retryAfterSeconds) },
    });
}
export async function admitPublic(
  limiter: SearchRateLimiter | undefined,
  request: FastifyRequest,
) {
  try {
    await admitExploreDirectoryRateLimit(
      limiter,
      exploreDirectoryAnonymousSubject(request),
      "Too many report requests. Please try again later.",
    );
  } catch (error) {
    if (error instanceof ProductHttpError) throw error;
    throw unavailable();
  }
}
export function param(request: FastifyRequest, name: string) {
  const v = (request.params as Record<string, string | undefined>)[name];
  if (!v || !/^[A-Za-z0-9._~-]{1,128}$/u.test(v)) throw notFound();
  return v;
}
export function objectBody(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidDocument();
  const b = value as Record<string, unknown>;
  if (Object.keys(b).some((k) => !keys.includes(k))) throw invalidDocument();
  return b;
}
export function stringField(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim() !== value || !value)
    throw invalidDocument();
  return value;
}
export function etag(revision: string) {
  return `"${revision}"`;
}
export function notFound() {
  return new ProductHttpError({
    statusCode: productErrorStatus("resource_not_found"),
    code: "resource_not_found",
    message: "Report was not found.",
    recovery: "none",
  });
}
export function invalidDocument() {
  return new ProductHttpError({
    statusCode: productErrorStatus("invalid_document"),
    code: "invalid_document",
    message: "Report request body is invalid.",
    recovery: "user_action",
  });
}
export function unavailable() {
  return new ProductHttpError({
    statusCode: 503,
    code: "feature_temporarily_unavailable",
    message: "Reports are temporarily unavailable.",
    recovery: "same_request",
    retryAfterSeconds: 1,
    headers: { "Retry-After": "1" },
  });
}
export function invalidCursor() {
  return new ProductHttpError({
    statusCode: 400,
    code: "invalid_cursor",
    message: "The report cursor is invalid.",
    recovery: "restart_from_first_page",
  });
}
export function cursorConfig(deps: ReportRoutesDependencies) {
  return {
    active: {
      id: deps.config.reports.cursor.active.id,
      secret: deps.config.reports.cursor.active.secret,
    },
    retained: deps.config.reports.cursor.retained,
  };
}
export function isInvalidCursor(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "invalid_cursor" ||
      (error as { code?: unknown }).code === "invalid_cursor" ||
      error.message === "invalid cursor")
  );
}

/** Verified bearer actor for the request, or `null` on the Cookie carrier. */
export const bearerActorOf = productBearerActorOf;

/**
 * Direct HTTP series writes cannot bind an approval to the requested policy
 * change. Machine publicization must use reports.plan/reports.commit, which
 * bind approval and reports:publish to the exact operations. An edition's
 * publish grant must never authorize exposing every issue in its series.
 */
export async function assertDirectSeriesPublicationAllowed(
  request: FastifyRequest,
  visibility: unknown,
): Promise<void> {
  if (visibility !== "public" && visibility !== "unlisted") return;
  if (await bearerActorOf(request)) {
    throw new ProductHttpError({
      statusCode: 403,
      code: "insufficient_permission",
      message: "Machine tokens must use an approved report plan to make a series public or unlisted.",
      recovery: "user_action",
    });
  }
}

/**
 * Fails closed when a bearer request wants to publish without the composed
 * grant/Plan gate: absent wiring must never silently fall back to the browser
 * flow, otherwise a machine token could publish without approval.
 */
export function requireReportPublishGuard(
  deps: ReportRoutesDependencies,
): import("../../modules/reports/index.js").ReportPublishGuard {
  if (deps.reportPublishGuard === undefined) {
    throw new ProductHttpError({
      statusCode: 403,
      code: "insufficient_permission",
      message: "Report publish requires a valid plan approval for machine tokens.",
      recovery: "user_action",
    });
  }
  return deps.reportPublishGuard;
}
export function parsePage(
  value: unknown,
  maxLimit = 100,
  extraKeys: readonly string[] = [],
): { limit?: number; cursor?: string } {
  const q = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const allowed = new Set(["limit", "cursor", ...extraKeys]);
  if (
    Object.keys(q).some((k) => !allowed.has(k)) ||
    (q.cursor !== undefined &&
      (typeof q.cursor !== "string" ||
        q.cursor.length < 1 ||
        q.cursor.length > 2048)) ||
    (q.limit !== undefined &&
      (!/^\d+$/u.test(String(q.limit)) ||
        Number(q.limit) < 1 ||
        Number(q.limit) > maxLimit))
  )
    throw invalidDocument();
  return {
    ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
    ...(q.cursor === undefined ? {} : { cursor: q.cursor as string }),
  };
}
export function mapReportError(error: unknown): ProductHttpError {
  if (error instanceof BookmarkSubscriptionError) mapSubscriptionError(error);
  if (error instanceof ProductHttpError) return error;
  if (error instanceof AccountCredentialCommandError) {
    const code = error.code === "insufficient_permission"
      ? "insufficient_permission"
      : "invalid_request";
    return new ProductHttpError({
      statusCode: productErrorStatus(code),
      code,
      message: error.message,
      recovery: error.code === "insufficient_permission" ? "user_action" : "same_request",
    });
  }
  if (error instanceof ReportsApplicationError) {
    if (error.code === "dependency_unavailable") return unavailable();
    const code =
      error.code === "resource_not_found"
        ? "resource_not_found"
        : error.code === "forbidden"
          ? "insufficient_permission"
          : error.code === "precondition_failed"
            ? "precondition_failed"
            : error.code === "conflict"
              ? "mutation_conflict"
              : "invalid_request";
    return new ProductHttpError({
      statusCode: productErrorStatus(code),
      code,
      message: "The report request is invalid.",
      recovery: "user_action",
    });
  }
  if (
    error instanceof ReportsDomainError &&
    error.code === "self_follow_forbidden"
  )
    return new ProductHttpError({
      statusCode: productErrorStatus("invalid_request"),
      code: "invalid_request",
      message: "Owners cannot follow their own report.",
      recovery: "user_action",
    });
  if (error instanceof ReportsDomainError)
    return new ProductHttpError({
      statusCode: productErrorStatus("invalid_request"),
      code: "invalid_request",
      message: "The report request is invalid.",
      recovery: "user_action",
    });
  if (
    error instanceof Error &&
    /^(report_(directory|projection)_limit_exceeded)$/u.test(error.message)
  )
    return unavailable();
  return new ProductHttpError({
    statusCode: 500,
    code: "internal_error",
    message: "Internal error.",
    recovery: "none",
  });
}
export function sendReportOutcome(
  reply: FastifyReply,
  outcome: ReportMutationResult<unknown>,
) {
  if (outcome.kind === "replay") {
    // Location is derived only for the two 201 endpoints.  It is not stored
    // as an arbitrary caller-supplied header, so replay cannot become a
    // redirect/open-redirect primitive.
    if (
      outcome.result.status === 201 &&
      outcome.result.targetIdentity &&
      outcome.result.stableHeaders.location === undefined
    ) {
      const path = reply.request.url.split("?", 1)[0] ?? reply.request.url;
      reply.header(
        "Location",
        `${path.replace(/\/$/u, "")}/${encodeURIComponent(outcome.result.targetIdentity)}`,
      );
    }
    return sendProductCommandReceiptOutcome(reply, {
      kind: "replay",
      status: outcome.result.status,
      body: outcome.result.body,
      stableHeaders: outcome.result.stableHeaders,
      mediaType: outcome.result.mediaType,
    });
  }
  if (outcome.kind === "in_progress")
    return sendProductCommandReceiptOutcome(reply, outcome);
  if (outcome.kind === "reused")
    return sendProductCommandReceiptOutcome(reply, outcome);
  if (outcome.kind === "expired")
    return sendProductCommandReceiptOutcome(reply, outcome);
  return mapReportError(new Error("unexpected report mutation outcome"));
}
export async function reportEditionPage(
  deps: ReportRoutesDependencies,
  seriesId: string,
  actor: ReportActor,
  query: { readonly limit?: number; readonly cursor?: string },
): Promise<{
  readonly items: readonly import("../../modules/reports/index.js").DigestEdition[];
  readonly nextCursor: string | null;
} | null> {
  if (query.cursor !== undefined && query.limit !== undefined)
    throw invalidDocument();
  const requestedLimit = query.limit;
  if (
    requestedLimit !== undefined &&
    (!Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > deps.config.reports.limits.pageMaxLimit)
  )
    throw invalidDocument();
  const signer = createReportsIssueCursorSigner(cursorConfig(deps));
  try {
    return await requireReportUnitOfWork(deps).execute(async (ports) => {
      const series = await ports.series.lockById(seriesId);
      if (!series || series.state === "archived") return null;
      if (series.ownerSubjectId !== actor.subjectId) {
        const member = await ports.members.get(series.id, actor.subjectId);
        if (!member || member.revokedAt) return null;
      }
      let limit = requestedLimit ?? 50;
      const principalId = `member:${seriesId}`;
      let items = [
        ...(await (ports.editions.listBySeries
          ? ports.editions.listBySeries(seriesId, 2_001)
          : [])),
      ];
      if (items.length > 2_000)
        throw new Error("report_projection_limit_exceeded");
      items.sort((left, right) => {
        const leftTime =
          left.publishedAt === null
            ? Number.NEGATIVE_INFINITY
            : Date.parse(left.publishedAt);
        const rightTime =
          right.publishedAt === null
            ? Number.NEGATIVE_INFINITY
            : Date.parse(right.publishedAt);
        return (
          rightTime - leftTime ||
          right.editionOrdinal - left.editionOrdinal ||
          left.id.localeCompare(right.id)
        );
      });
      const cursorFence = createHash("sha256")
        .update(
          JSON.stringify({
            policyRevision: series.policyRevision,
            contentRevision: series.contentRevision,
            editions: items.map((item) => ({
              id: item.id,
              state: item.state,
              publishedAt: item.publishedAt,
              editionOrdinal: item.editionOrdinal,
              resourceRevision: item.resourceRevision,
            })),
          }),
          "utf8",
        )
        .digest("hex");
      if (query.cursor) {
        const cursor = signer.verify(query.cursor, new Date());
        if (
          cursor.principalId !== principalId ||
          cursor.policyRevision !== cursorFence
        )
          throw invalidCursor();
        limit = cursor.limit;
        const index = items.findIndex((item) => item.id === cursor.after.id);
        items = index < 0 ? [] : items.slice(index + 1);
      }
      const page = items.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        items.length > limit && last
          ? signer.sign(
              createReportsIssueCursorPayload({
                principalId,
                policyRevision: cursorFence,
                limit,
                after: {
                  id: last.id,
                  publishedAt: last.publishedAt ?? new Date(0).toISOString(),
                  editionOrdinal: last.editionOrdinal,
                },
                ttlMs: deps.config.reports.cursor.ttlMs,
              }),
            )
          : null;
      return { items: page, nextCursor };
    });
  } finally {
    signer.destroy();
  }
}
