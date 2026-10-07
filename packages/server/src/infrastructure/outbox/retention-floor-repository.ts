import type { Pool } from 'pg';

export interface OutboxRetentionFloorKey {
  readonly handlerName: string;
  readonly eventType: string;
  readonly aggregateScope: string;
}

export interface OutboxRetentionPosition {
  readonly commitOrdinal: string;
  readonly domainEventId: string | null;
}

export interface OutboxRetentionFloor extends OutboxRetentionFloorKey {
  readonly position: OutboxRetentionPosition;
  readonly stateRevision: string;
  readonly advancedAt: Date | null;
}

export type OutboxRetentionFloorErrorCode =
  | 'OUTBOX_RETENTION_FLOOR_INVALID'
  | 'OUTBOX_RETENTION_FLOOR_REGRESSION'
  | 'OUTBOX_RETENTION_FLOOR_CAS_CONFLICT'
  | 'OUTBOX_RETENTION_FLOOR_BOUNDARY_MISSING'
  | 'OUTBOX_RETENTION_FLOOR_POLICY_UNSUPPORTED'
  | 'OUTBOX_RETENTION_FLOOR_POLICY_WINDOW'
  | 'OUTBOX_RETENTION_FLOOR_UNRESOLVED_SOURCE';

export class OutboxRetentionFloorError extends Error {
  public constructor(
    public readonly code: OutboxRetentionFloorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutboxRetentionFloorError';
  }
}

export interface OutboxRetentionFloorRepository {
  /** Missing authority is returned as the implicit floor zero and does not write. */
  read(key: OutboxRetentionFloorKey): Promise<OutboxRetentionFloor>;
  /** Idempotently materializes the initial floor-zero authority. */
  create(key: OutboxRetentionFloorKey): Promise<OutboxRetentionFloor>;
  /** Advances authority only; this operation never deletes an Outbox event. */
  advance(input: AdvanceOutboxRetentionFloorInput): Promise<OutboxRetentionFloor>;
}

export interface AdvanceOutboxRetentionFloorInput extends OutboxRetentionFloorKey {
  readonly position: OutboxRetentionPosition;
  readonly expectedStateRevision: string;
}

interface FloorRow {
  handler_name: string;
  event_type: string;
  aggregate_scope: string;
  floor_commit_ordinal: string;
  floor_domain_event_id: string | null;
  state_revision: string;
  advanced_at: Date;
}

interface PostgresErrorLike {
  readonly code?: string;
  readonly constraint?: string;
}

export function createPostgresOutboxRetentionFloorRepository(
  pool: Pool,
): OutboxRetentionFloorRepository {
  return Object.freeze({
    async read(key: OutboxRetentionFloorKey): Promise<OutboxRetentionFloor> {
      assertKey(key);
      const result = await pool.query<FloorRow>(selectFloorSql, keyValues(key));
      return result.rows[0] ? mapFloor(result.rows[0]) : implicitFloor(key);
    },

    async create(key: OutboxRetentionFloorKey): Promise<OutboxRetentionFloor> {
      assertKey(key);
      await pool.query(`insert into outbox_retention_floors(
          handler_name,event_type,aggregate_scope)
        values($1,$2,$3) on conflict (handler_name,event_type,aggregate_scope) do nothing`,
      keyValues(key));
      const result = await pool.query<FloorRow>(selectFloorSql, keyValues(key));
      if (!result.rows[0]) throw new Error('Outbox retention floor create did not persist');
      return mapFloor(result.rows[0]);
    },

    async advance(input: AdvanceOutboxRetentionFloorInput): Promise<OutboxRetentionFloor> {
      assertKey(input);
      const nextOrdinal = parseNonnegativeBigint(input.position.commitOrdinal, 'commitOrdinal');
      if (nextOrdinal === 0n || !validIdentity(input.position.domainEventId)) {
        throw floorError('OUTBOX_RETENTION_FLOOR_INVALID',
          'An advanced retention floor requires a positive ordinal and domain event id');
      }
      const expectedRevision = parseNonnegativeBigint(
        input.expectedStateRevision, 'expectedStateRevision',
      );
      const current = await pool.query<FloorRow>(selectFloorSql, keyValues(input));
      if (!current.rows[0] || BigInt(current.rows[0].state_revision) !== expectedRevision) {
        throw floorError('OUTBOX_RETENTION_FLOOR_CAS_CONFLICT',
          'Outbox retention floor state revision changed');
      }
      if (comparePosition(input.position, mapFloor(current.rows[0]).position) <= 0) {
        throw floorError('OUTBOX_RETENTION_FLOOR_REGRESSION',
          'Outbox retention floor must advance monotonically');
      }
      try {
        const advanced = await pool.query<FloorRow>(`update outbox_retention_floors set
            floor_commit_ordinal=$4,floor_domain_event_id=$5,
            state_revision=state_revision+1,advanced_at=current_timestamp
          where handler_name=$1 and event_type=$2 and aggregate_scope=$3
            and state_revision=$6
          returning handler_name,event_type,aggregate_scope,floor_commit_ordinal::text,
            floor_domain_event_id,state_revision::text,advanced_at`,
        [...keyValues(input), nextOrdinal.toString(), input.position.domainEventId,
          expectedRevision.toString()]);
        if (!advanced.rows[0]) {
          throw floorError('OUTBOX_RETENTION_FLOOR_CAS_CONFLICT',
            'Outbox retention floor state revision changed');
        }
        return mapFloor(advanced.rows[0]);
      } catch (error: unknown) {
        if (isConstraint(error, 'outbox_retention_floors_policy_unsupported')) {
          throw floorError('OUTBOX_RETENTION_FLOOR_POLICY_UNSUPPORTED',
            'No retention policy authorizes this Outbox source stream');
        }
        if (isConstraint(error, 'outbox_retention_floors_policy_window')) {
          throw floorError('OUTBOX_RETENTION_FLOOR_POLICY_WINDOW',
            'Social Feed retention floor violates the 90-day minimum');
        }
        if (isConstraint(error, 'outbox_retention_floors_boundary_missing')) {
          throw floorError('OUTBOX_RETENTION_FLOOR_BOUNDARY_MISSING',
            'Outbox retention floor boundary is not a completed source tuple');
        }
        if (isConstraint(error, 'outbox_retention_floors_unresolved_source')) {
          throw floorError('OUTBOX_RETENTION_FLOOR_UNRESOLVED_SOURCE',
            'Outbox retention floor cannot pass unresolved source rows');
        }
        throw error;
      }
    },
  });
}

const selectFloorSql = `select handler_name,event_type,aggregate_scope,
  floor_commit_ordinal::text,floor_domain_event_id,state_revision::text,advanced_at
  from outbox_retention_floors
  where handler_name=$1 and event_type=$2 and aggregate_scope=$3`;

function keyValues(key: OutboxRetentionFloorKey): [string, string, string] {
  return [key.handlerName, key.eventType, key.aggregateScope];
}

function implicitFloor(key: OutboxRetentionFloorKey): OutboxRetentionFloor {
  return Object.freeze({ ...key, position: Object.freeze({ commitOrdinal: '0',
    domainEventId: null }), stateRevision: '0', advancedAt: null });
}

function mapFloor(row: FloorRow): OutboxRetentionFloor {
  return Object.freeze({ handlerName: row.handler_name, eventType: row.event_type,
    aggregateScope: row.aggregate_scope, position: Object.freeze({
      commitOrdinal: row.floor_commit_ordinal, domainEventId: row.floor_domain_event_id,
    }), stateRevision: row.state_revision, advancedAt: row.advanced_at });
}

function assertKey(key: OutboxRetentionFloorKey): void {
  for (const [name, value] of [
    ['handlerName', key.handlerName],
    ['eventType', key.eventType],
    ['aggregateScope', key.aggregateScope],
  ] as const) {
    if (!validIdentity(value)) {
      throw floorError('OUTBOX_RETENTION_FLOOR_INVALID', `${name} is invalid`);
    }
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value.trim() === value;
}

function parseNonnegativeBigint(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw floorError('OUTBOX_RETENTION_FLOOR_INVALID', `${name} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw floorError('OUTBOX_RETENTION_FLOOR_INVALID', `${name} is invalid`);
  }
  return parsed;
}

function comparePosition(left: OutboxRetentionPosition, right: OutboxRetentionPosition): number {
  const ordinal = BigInt(left.commitOrdinal) - BigInt(right.commitOrdinal);
  if (ordinal !== 0n) return ordinal < 0n ? -1 : 1;
  return (left.domainEventId ?? '').localeCompare(right.domainEventId ?? '');
}

function isConstraint(error: unknown, constraint: string): boolean {
  return typeof error === 'object' && error !== null
    && (error as PostgresErrorLike).code === '23514'
    && (error as PostgresErrorLike).constraint === constraint;
}

function floorError(code: OutboxRetentionFloorErrorCode, message: string) {
  return new OutboxRetentionFloorError(code, message);
}
