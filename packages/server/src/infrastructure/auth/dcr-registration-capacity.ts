import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Metrics } from '../telemetry/index.js';

const DCR_ADVISORY_LOCK_NAMESPACE = 1_264_644_467;
const DCR_ADVISORY_LOCK_KEY = 1;
export const DCR_RESERVATION_TTL_SECONDS = 300;
const DCR_CAPACITY_RETRY_AFTER_SECONDS = 60;

export const AUTH_DCR_METRIC_NAME_ALLOWLIST = Object.freeze([
  'auth.dcr.admission.anonymous.accepted',
  'auth.dcr.admission.anonymous.denied_capacity',
  'auth.dcr.admission.owned.accepted',
  'auth.dcr.admission.owned.denied_user',
  'auth.dcr.admission.owned.denied_global',
  'auth.dcr.admission.malformed_201',
  'auth.dcr.admission.store_error',
  'auth.dcr.reclaim.anonymous',
  'auth.dcr.reclaim.owned',
]);

const AUTH_DCR_METRIC_ALLOWLIST = new Set<string>(AUTH_DCR_METRIC_NAME_ALLOWLIST);

export function incrementAuthDcrMetric(
  metrics: Metrics | undefined,
  name: string,
  value = 1,
): void {
  if (!AUTH_DCR_METRIC_ALLOWLIST.has(name)) {
    throw new TypeError(`Unknown DCR admission metric: ${name}`);
  }
  if (metrics === undefined || value <= 0) return;
  metrics.increment(name, value);
}

export type DcrReserveDeniedReason = 'anonymous' | 'owned_user' | 'owned_global';

export type DcrReserveResult =
  | {
      readonly ok: true;
      readonly reservationId: string;
      readonly reclaimedAnonymous: number;
      readonly reclaimedOwned: number;
    }
  | {
      readonly ok: false;
      readonly reason: DcrReserveDeniedReason;
      readonly reclaimedAnonymous: number;
      readonly reclaimedOwned: number;
    };

export interface DcrRegistrationReservationStore {
  /** Atomically reclaim stale rows and reserve one anonymous capacity slot. */
  readonly reserveAnonymous: () => Promise<DcrReserveResult>;
  /** Reclaim stale rows and admit one session-owned DCR client for `userId`. */
  readonly reserveOwned: (input: { readonly userId: string }) => Promise<DcrReserveResult>;
  /** Bind a reserved anonymous slot to the newly persisted Better Auth client. */
  readonly finalize: (reservationId: string, clientId: string) => Promise<void>;
  /**
   * Drop a pending owned reservation after Better Auth persisted an owned
   * client. Throws if the 201 client is unowned so the guard can fail closed.
   */
  readonly completeOwned: (reservationId: string, clientId: string) => Promise<void>;
  /** Release a reservation when Better Auth did not create a client. */
  readonly cancel: (reservationId: string) => Promise<void>;
}

export interface DcrRegistrationCapacityGuard {
  readonly dispatch: (operation: () => Promise<Response>) => Promise<Response>;
  readonly dispatchOwned: (
    operation: () => Promise<Response>,
    userId: string,
  ) => Promise<Response>;
}

export interface PostgresDcrRegistrationCapacityOptions<DB> {
  readonly db: Kysely<DB>;
  readonly maxAnonymousClients: number;
  readonly unusedClientRetentionSeconds: number;
  readonly maxOwnedClientsPerUser: number;
  readonly maxOwnedClients: number;
}

export function dcrCapacityUnavailableResponse(): Response {
  return Response.json({
    error: 'temporarily_unavailable',
    error_description: 'Dynamic client registration capacity is temporarily unavailable.',
  }, {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'retry-after': String(DCR_CAPACITY_RETRY_AFTER_SECONDS),
    },
  });
}

async function responseClientId(response: Response): Promise<string | null> {
  if (response.status !== 201) return null;
  try {
    const body = await response.clone().json() as { readonly client_id?: unknown };
    return typeof body.client_id === 'string' && body.client_id.length > 0
      ? body.client_id
      : null;
  } catch {
    return null;
  }
}

function recordReserveMetrics(
  metrics: Metrics | undefined,
  result: DcrReserveResult,
  kind: 'anonymous' | 'owned',
): void {
  incrementAuthDcrMetric(metrics, 'auth.dcr.reclaim.anonymous', result.reclaimedAnonymous);
  incrementAuthDcrMetric(metrics, 'auth.dcr.reclaim.owned', result.reclaimedOwned);
  if (result.ok) return;
  if (kind === 'anonymous') {
    incrementAuthDcrMetric(metrics, 'auth.dcr.admission.anonymous.denied_capacity');
    return;
  }
  incrementAuthDcrMetric(
    metrics,
    result.reason === 'owned_global'
      ? 'auth.dcr.admission.owned.denied_global'
      : 'auth.dcr.admission.owned.denied_user',
  );
}

/**
 * Wrap the RFC 7591 handler in a fail-closed reservation lifecycle. A 201 is
 * exposed only after its client_id is durably bound to the reserved slot
 * (anonymous) or after Better Auth persisted an owned client (session path).
 */
export function createDcrRegistrationCapacityGuard(
  store: DcrRegistrationReservationStore,
  options: { readonly metrics?: Metrics } = {},
): DcrRegistrationCapacityGuard {
  const metrics = options.metrics;

  async function admit(
    kind: 'anonymous' | 'owned',
    reserve: () => Promise<DcrReserveResult>,
    operation: () => Promise<Response>,
  ): Promise<Response> {
    let result: DcrReserveResult;
    try {
      result = await reserve();
    } catch {
      incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
      return dcrCapacityUnavailableResponse();
    }
    recordReserveMetrics(metrics, result, kind);
    if (!result.ok) return dcrCapacityUnavailableResponse();
    const reservationId = result.reservationId;

    let response: Response;
    try {
      response = await operation();
    } catch (error: unknown) {
      try {
        await store.cancel(reservationId);
      } catch (cancelError: unknown) {
        incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
        throw new AggregateError(
          [error, cancelError],
          'DCR handler and reservation cancellation both failed',
        );
      }
      throw error;
    }

    const clientId = await responseClientId(response);
    if (clientId === null) {
      if (response.status !== 201) {
        try {
          await store.cancel(reservationId);
        } catch {
          // The rejected client response remains authoritative, while the
          // bounded reservation expires naturally. Make the cleanup failure
          // observable instead of hiding it as a successful cancellation.
          incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
        }
        return response;
      }
      incrementAuthDcrMetric(metrics, 'auth.dcr.admission.malformed_201');
      // Keep the short reservation for reconciliation: a malformed 201 may
      // already have committed a client row, so freeing the slot here would
      // reopen unbounded growth.
      return dcrCapacityUnavailableResponse();
    }
    if (kind === 'owned') {
      try {
        await store.completeOwned(reservationId, clientId);
      } catch {
        incrementAuthDcrMetric(metrics, 'auth.dcr.admission.malformed_201');
        return dcrCapacityUnavailableResponse();
      }
      incrementAuthDcrMetric(metrics, 'auth.dcr.admission.owned.accepted');
      return response;
    }
    try {
      await store.finalize(reservationId, clientId);
    } catch {
      incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
      // The pending row remains bounded and the next admission reconciles
      // any untracked client older than the reservation TTL.
      return dcrCapacityUnavailableResponse();
    }
    incrementAuthDcrMetric(metrics, 'auth.dcr.admission.anonymous.accepted');
    return response;
  }

  return {
    dispatch(operation) {
      return admit('anonymous', () => store.reserveAnonymous(), operation);
    },
    dispatchOwned(operation, userId) {
      if (typeof userId !== 'string' || userId.length === 0) {
        incrementAuthDcrMetric(metrics, 'auth.dcr.admission.store_error');
        return Promise.resolve(dcrCapacityUnavailableResponse());
      }
      return admit('owned', () => store.reserveOwned({ userId }), operation);
    },
  };
}

function assertCapacityOption(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function exactCount(raw: string | undefined, label: string): number {
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(label);
  }
  return count;
}

/** Live access/refresh tokens (unrevoked and unexpired) block reclaim. Consent does not. */
const NO_LIVE_TOKENS_SQL = sql`
  AND NOT EXISTS (
    SELECT 1 FROM "auth_oauth_access_token" x
    WHERE x."clientId" = c."clientId"
      AND x."revoked" IS NULL
      AND x."expiresAt" > now()
  )
  AND NOT EXISTS (
    SELECT 1 FROM "auth_oauth_refresh_token" x
    WHERE x."clientId" = c."clientId"
      AND x."revoked" IS NULL
      AND x."expiresAt" > now()
  )
`;

/**
 * PostgreSQL-backed global capacity store. The advisory lock is held only for
 * the short reserve transaction; Better Auth runs after it commits, so a burst
 * cannot exhaust the connection pool with lock waiters while the handler needs
 * another connection.
 */
export function createPostgresDcrRegistrationReservationStore<DB>(
  options: PostgresDcrRegistrationCapacityOptions<DB>,
): DcrRegistrationReservationStore {
  assertCapacityOption('maxAnonymousClients', options.maxAnonymousClients);
  assertCapacityOption('unusedClientRetentionSeconds', options.unusedClientRetentionSeconds);
  assertCapacityOption('maxOwnedClientsPerUser', options.maxOwnedClientsPerUser);
  assertCapacityOption('maxOwnedClients', options.maxOwnedClients);

  async function prepareAdmission(transaction: Kysely<DB>): Promise<{
    readonly reclaimedAnonymous: number;
    readonly reclaimedOwned: number;
  }> {
    await sql`SELECT pg_advisory_xact_lock(
      ${DCR_ADVISORY_LOCK_NAMESPACE}, ${DCR_ADVISORY_LOCK_KEY}
    )`.execute(transaction);

    // Recover a client whose 201 committed but whose reservation could not
    // be finalized. The age threshold prevents racing a live handler.
    await sql`INSERT INTO "auth_oauth_dcr_registration"
        ("id", "clientId", "expiresAt", "reclaimable", "createdAt", "ownerUserId")
      SELECT 'recovered:' || c."id", c."clientId", 'infinity'::timestamptz,
             false, COALESCE(c."createdAt", now()), NULL
      FROM "auth_oauth_client" c
      WHERE c."clientDiscoveryId" IS NULL
        AND c."userId" IS NULL
        AND c."referenceId" IS NULL
        AND COALESCE(c."createdAt", '-infinity'::timestamptz)
            <= now() - (${DCR_RESERVATION_TTL_SECONDS} * interval '1 second')
        AND NOT EXISTS (
          SELECT 1 FROM "auth_oauth_dcr_registration" r
          WHERE r."clientId" = c."clientId"
        )
      ON CONFLICT DO NOTHING`.execute(transaction);

    await sql`DELETE FROM "auth_oauth_dcr_registration"
      WHERE "clientId" IS NULL AND "expiresAt" <= now()`.execute(transaction);

    // Delete only registrations created by this guard, only after their
    // unused retention, and only when no live access/refresh token exists.
    // Immortal consent rows must not keep the slot.
    const anonymousDeleted = await sql<{ readonly clientId: string }>`
      DELETE FROM "auth_oauth_client" c
      USING "auth_oauth_dcr_registration" r
      WHERE r."clientId" = c."clientId"
        AND r."reclaimable" = true
        AND r."expiresAt" <= now()
        ${NO_LIVE_TOKENS_SQL}
      RETURNING c."clientId"`.execute(transaction);

    const ownedDeleted = await sql<{ readonly clientId: string }>`
      DELETE FROM "auth_oauth_client" c
      WHERE c."clientDiscoveryId" IS NULL
        AND (c."userId" IS NOT NULL OR c."referenceId" IS NOT NULL)
        AND COALESCE(c."createdAt", '-infinity'::timestamptz)
            <= now() - (${options.unusedClientRetentionSeconds} * interval '1 second')
        ${NO_LIVE_TOKENS_SQL}
      RETURNING c."clientId"`.execute(transaction);

    return {
      reclaimedAnonymous: anonymousDeleted.rows.length,
      reclaimedOwned: ownedDeleted.rows.length,
    };
  }

  return {
    async reserveAnonymous() {
      const reservationId = randomUUID();
      return options.db.transaction().execute(async (transaction) => {
        const reclaimed = await prepareAdmission(transaction as unknown as Kysely<DB>);
        const countResult = await sql<{ readonly count: string }>`
          SELECT count(*)::text AS count FROM "auth_oauth_dcr_registration"
          WHERE "ownerUserId" IS NULL
        `.execute(transaction);
        const count = exactCount(countResult.rows[0]?.count, 'invalid anonymous DCR registration count');
        if (count >= options.maxAnonymousClients) {
          return { ok: false, reason: 'anonymous' as const, ...reclaimed };
        }

        await sql`INSERT INTO "auth_oauth_dcr_registration"
            ("id", "clientId", "expiresAt", "reclaimable", "createdAt", "ownerUserId")
          VALUES (
            ${reservationId}, NULL,
            now() + (${DCR_RESERVATION_TTL_SECONDS} * interval '1 second'),
            false, now(), NULL
          )`.execute(transaction);
        return { ok: true, reservationId, ...reclaimed };
      });
    },

    async reserveOwned({ userId }) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('owned DCR reservation requires a session user id');
      }
      const reservationId = randomUUID();
      return options.db.transaction().execute(async (transaction) => {
        const reclaimed = await prepareAdmission(transaction as unknown as Kysely<DB>);
        const perUserResult = await sql<{ readonly count: string }>`
          SELECT (
            (SELECT count(*) FROM "auth_oauth_client"
             WHERE "clientDiscoveryId" IS NULL AND "userId" = ${userId})
            +
            (SELECT count(*) FROM "auth_oauth_dcr_registration"
             WHERE "ownerUserId" = ${userId} AND "clientId" IS NULL)
          )::text AS count
        `.execute(transaction);
        const perUser = exactCount(perUserResult.rows[0]?.count, 'invalid owned DCR per-user count');
        if (perUser >= options.maxOwnedClientsPerUser) {
          return { ok: false, reason: 'owned_user' as const, ...reclaimed };
        }

        const globalResult = await sql<{ readonly count: string }>`
          SELECT (
            (SELECT count(*) FROM "auth_oauth_client"
             WHERE "clientDiscoveryId" IS NULL
               AND ("userId" IS NOT NULL OR "referenceId" IS NOT NULL))
            +
            (SELECT count(*) FROM "auth_oauth_dcr_registration"
             WHERE "ownerUserId" IS NOT NULL AND "clientId" IS NULL)
          )::text AS count
        `.execute(transaction);
        const globalOwned = exactCount(globalResult.rows[0]?.count, 'invalid owned DCR global count');
        if (globalOwned >= options.maxOwnedClients) {
          return { ok: false, reason: 'owned_global' as const, ...reclaimed };
        }

        await sql`INSERT INTO "auth_oauth_dcr_registration"
            ("id", "clientId", "expiresAt", "reclaimable", "createdAt", "ownerUserId")
          VALUES (
            ${reservationId}, NULL,
            now() + (${DCR_RESERVATION_TTL_SECONDS} * interval '1 second'),
            false, now(), ${userId}
          )`.execute(transaction);
        return { ok: true, reservationId, ...reclaimed };
      });
    },

    async finalize(reservationId, clientId) {
      await options.db.transaction().execute(async (transaction) => {
        const result = await sql<{ readonly id: string }>`UPDATE "auth_oauth_dcr_registration" r
          SET "clientId" = ${clientId},
              "expiresAt" = now() + (${options.unusedClientRetentionSeconds} * interval '1 second'),
              "reclaimable" = true
          WHERE r."id" = ${reservationId} AND r."clientId" IS NULL
            AND r."ownerUserId" IS NULL
            AND EXISTS (
              SELECT 1 FROM "auth_oauth_client" c
              WHERE c."clientId" = ${clientId}
                AND c."clientDiscoveryId" IS NULL
                AND c."userId" IS NULL
                AND c."referenceId" IS NULL
            )
          RETURNING r."id"`.execute(transaction);
        if (result.rows.length === 1) return;

        // Better Auth may authorize DCR with a browser session or an initial
        // access token. Those owned clients are not anonymous capacity and
        // must never become reclaimable under this policy.
        const owned = await sql<{ readonly found: number }>`SELECT 1 AS found
          FROM "auth_oauth_client"
          WHERE "clientId" = ${clientId}
            AND ("userId" IS NOT NULL OR "referenceId" IS NOT NULL)
          LIMIT 1`.execute(transaction);
        if (owned.rows.length === 1) {
          await sql`DELETE FROM "auth_oauth_dcr_registration"
            WHERE "id" = ${reservationId} AND "clientId" IS NULL`.execute(transaction);
          return;
        }
        throw new Error('anonymous DCR reservation no longer exists');
      });
    },

    async completeOwned(reservationId, clientId) {
      await options.db.transaction().execute(async (transaction) => {
        const pending = await sql<{ readonly id: string }>`
          SELECT r."id" FROM "auth_oauth_dcr_registration" r
          WHERE r."id" = ${reservationId} AND r."clientId" IS NULL
            AND r."ownerUserId" IS NOT NULL
        `.execute(transaction);
        if (pending.rows.length !== 1) {
          throw new Error('owned DCR reservation no longer exists');
        }
        const owned = await sql<{ readonly found: number }>`SELECT 1 AS found
          FROM "auth_oauth_client"
          WHERE "clientId" = ${clientId}
            AND ("userId" IS NOT NULL OR "referenceId" IS NOT NULL)
          LIMIT 1`.execute(transaction);
        if (owned.rows.length !== 1) {
          throw new Error('owned DCR 201 did not persist an owned client');
        }
        await sql`DELETE FROM "auth_oauth_dcr_registration"
          WHERE "id" = ${reservationId} AND "clientId" IS NULL
            AND "ownerUserId" IS NOT NULL`.execute(transaction);
      });
    },

    async cancel(reservationId) {
      await sql`DELETE FROM "auth_oauth_dcr_registration"
        WHERE "id" = ${reservationId} AND "clientId" IS NULL`.execute(options.db);
    },
  };
}
