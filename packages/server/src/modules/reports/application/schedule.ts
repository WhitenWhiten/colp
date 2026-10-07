import rrulePackage from 'rrule';
import { DateTime } from 'luxon';
import { createHash, randomUUID } from 'node:crypto';
import type { DigestSchedule } from '../domain/types.js';
import type {
  ReportActor,
  ReportMutationResult,
  ReportUnitOfWork,
} from './contracts.js';
import { assertCanonicalCommandId, canonicalJson } from '../../commands/index.js';
import { ReportsApplicationError } from './report-commands.js';

const { RRule, rrulestr } = rrulePackage;

/** Hard ceiling for recurrence work, including dates outside the requested window. */
export const MAX_OCCURRENCE_SCAN = 10_000;
export const MAX_OCCURRENCE_LIMIT = 1_000;
const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_FINITE_RULE_COUNT = 100_000;

export interface ScheduleInput {
  readonly rrule: string;
  readonly dtstart: string | Date;
  readonly timeZone: string;
  readonly catchUpPolicy?: 'skip' | 'one';
  readonly maxCatchUp?: number;
}

function invalidSchedule(message: string): never {
  throw new Error(message);
}

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const ACTOR_ID = /^(?:[^\u0000-\u001f\u007f]){1,256}$/u;

function assertActor(input: ScheduleMutationInput): void {
  if (!OPAQUE_ID.test(input.seriesId)
    || typeof input.actor.principalId !== 'string' || !ACTOR_ID.test(input.actor.principalId)
    || typeof input.actor.subjectId !== 'string' || !ACTOR_ID.test(input.actor.subjectId)) {
    throw new ReportsApplicationError('invalid_request', 'report identity is invalid');
  }
}

async function clockNow(ports: import('./contracts.js').ReportTransactionPorts): Promise<Date> {
  const value = await ports.clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ReportsApplicationError('invalid_request', 'invalid clock');
  }
  return value;
}

function assertZone(zone: string): string {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 128
    || /[\u0000-\u001f\u007f]/u.test(zone)) {
    return invalidSchedule('invalid timezone');
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone })
      .resolvedOptions().timeZone;
    if (!resolved) return invalidSchedule('invalid timezone');
    return resolved;
  } catch {
    return invalidSchedule('invalid timezone');
  }
}

/** Parse and canonicalise the closed RFC5545 RRULE subset accepted by Reports. */
export function canonicalRRule(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024
    || /[\u0000-\u001f\u007f\r\n]/u.test(value)) {
    return invalidSchedule('invalid rrule');
  }
  const raw = value.trim().replace(/^RRULE:/iu, '');
  if (raw.length === 0 || raw.includes(':')) return invalidSchedule('invalid rrule');
  const parts = raw.split(';');
  if (parts.some((part) => part.trim().length === 0)) return invalidSchedule('invalid rrule');
  const seen = new Set<string>();
  const pairs = parts.map((part) => {
    const [keyPart, ...rest] = part.split('=');
    const key = keyPart?.trim().toUpperCase();
    if (!key || rest.length === 0 || !/^[A-Z][A-Z0-9-]*$/u.test(key)
      || seen.has(key)) return invalidSchedule('invalid rrule');
    const fieldValue = rest.join('=').trim().toUpperCase();
    if (fieldValue.length === 0 || /[\u0000-\u001f\u007f]/u.test(fieldValue)) {
      return invalidSchedule('invalid rrule');
    }
    seen.add(key);
    return [key, fieldValue] as const;
  });
  if (!pairs.some(([key]) => key === 'FREQ')) return invalidSchedule('invalid rrule');

  const byKey = new Map(pairs);
  const frequency = byKey.get('FREQ');
  if (!frequency || !['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY']
    .includes(frequency)) return invalidSchedule('invalid rrule');
  const interval = byKey.get('INTERVAL');
  if (interval !== undefined
    && (!/^\d+$/u.test(interval) || Number(interval) < 1 || Number(interval) > 100_000)) {
    return invalidSchedule('invalid rrule');
  }
  const count = byKey.get('COUNT');
  if (count !== undefined
    && (!/^\d+$/u.test(count) || Number(count) < 1 || Number(count) > MAX_FINITE_RULE_COUNT)) {
    return invalidSchedule('invalid rrule');
  }
  // Unbounded high-frequency rules are an easy CPU/memory denial-of-service.
  if ((frequency === 'MINUTELY' || frequency === 'SECONDLY')
    && count === undefined && byKey.get('UNTIL') === undefined) {
    return invalidSchedule('high-frequency rrule must have COUNT or UNTIL');
  }

  const out = pairs.sort(([a], [b]) => a.localeCompare(b))
    .map(([key, fieldValue]) => `${key}=${fieldValue}`).join(';');
  try {
    const parsed = rrulestr(`RRULE:${out}`);
    if (!(parsed instanceof RRule)) return invalidSchedule('invalid rrule');
  } catch {
    return invalidSchedule('invalid rrule');
  }
  return out;
}

function normalizeDtstart(value: string | Date): Date {
  if (typeof value === 'string' && !RFC3339_WITH_OFFSET.test(value)) {
    return invalidSchedule('dtstart must be RFC3339 with an explicit offset');
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return invalidSchedule('invalid dtstart');
  return date;
}

export function normalizeSchedule(
  input: ScheduleInput,
): Omit<DigestSchedule, 'id' | 'seriesId' | 'resourceRevision' | 'nextRunAt' | 'enabled'> {
  const zone = assertZone(input.timeZone);
  const dt = normalizeDtstart(input.dtstart);
  const maxCatchUp = input.maxCatchUp ?? 0;
  if (!Number.isInteger(maxCatchUp) || maxCatchUp < 0 || maxCatchUp > 100) {
    return invalidSchedule('invalid catch-up quota');
  }
  const policy = input.catchUpPolicy ?? 'skip';
  if (policy !== 'skip' && policy !== 'one') return invalidSchedule('invalid catch-up policy');
  return {
    rrule: canonicalRRule(input.rrule),
    dtstart: dt.toISOString(),
    timeZone: zone,
    catchUpPolicy: policy,
    maxCatchUp,
  };
}

function wallClockDate(date: DateTime): Date {
  return new Date(Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    date.hour,
    date.minute,
    date.second,
    date.millisecond,
  ));
}

/**
 * Luxon month/year addition clamps 31 Jan → 28 Feb and 29 Feb → 28 Feb.
 * Rebuilding the RRULE with that clamped DTSTART would change the implicit
 * BYMONTHDAY. Pin the original calendar fields when the rule did not name them.
 */
function preserveOriginalCalendarAnchor(
  orig: NonNullable<ConstructorParameters<typeof RRule>[0]>,
  start: DateTime,
): NonNullable<ConstructorParameters<typeof RRule>[0]> {
  const extra: Record<string, unknown> = {};
  if (orig.freq === RRule.MONTHLY && orig.bymonthday == null && orig.bynmonthday == null
      && orig.byweekday == null) {
    extra.bymonthday = start.day;
  }
  if (orig.freq === RRule.YEARLY && orig.bymonthday == null && orig.bynmonthday == null
      && orig.byweekday == null && orig.byyearday == null && orig.byweekno == null) {
    extra.bymonthday = start.day;
    if (orig.bymonth == null) extra.bymonth = start.month;
  }
  return { ...orig, ...extra };
}

/**
 * Choose a bounded wall-clock scan origin for an unbounded rule.  rrule's
 * `between()` otherwise walks from the historical DTSTART on every poll (a
 * daily schedule that has existed for ten years would exceed the scan guard).
 * The origin is aligned to the original interval so DAILY/WEEKLY rules retain
 * their phase; finite COUNT rules deliberately keep DTSTART because COUNT is
 * defined relative to it.
 */
function recurrenceScanStart(
  start: DateTime,
  from: Date,
  parsed: InstanceType<typeof RRule>,
  zone: string,
): DateTime {
  const options = parsed.options;
  // COUNT is anchored to DTSTART and must retain the original origin. UNTIL
  // only caps the end of a recurrence and does not change its phase, so it can
  // still use the aligned bounded origin below.
  if (options.count !== null) return start;
  const localFrom = DateTime.fromJSDate(from, { zone });
  if (!localFrom.isValid || localFrom <= start) return start;
  const interval = Math.max(1, options.interval ?? 1);
  if (options.freq === RRule.DAILY) {
    const distance = Math.max(0, Math.floor(localFrom.diff(start, 'days').days));
    return start.plus({ days: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  if (options.freq === RRule.WEEKLY) {
    const distance = Math.max(0, Math.floor(localFrom.diff(start, 'days').days / 7));
    return start.plus({ days: Math.max(0, Math.floor(distance / interval) - 1) * interval * 7 });
  }
  if (options.freq === RRule.MONTHLY) {
    const distance = Math.max(0,
      (localFrom.year - start.year) * 12 + localFrom.month - start.month);
    return start.plus({ months: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  if (options.freq === RRule.YEARLY) {
    const distance = Math.max(0, localFrom.year - start.year);
    return start.plus({ years: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  if (options.freq === RRule.HOURLY) {
    const distance = Math.max(0, Math.floor(localFrom.diff(start, 'hours').hours));
    return start.plus({ hours: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  if (options.freq === RRule.MINUTELY) {
    const distance = Math.max(0, Math.floor(localFrom.diff(start, 'minutes').minutes));
    return start.plus({ minutes: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  if (options.freq === RRule.SECONDLY) {
    const distance = Math.max(0, Math.floor(localFrom.diff(start, 'seconds').seconds));
    return start.plus({ seconds: Math.max(0, Math.floor(distance / interval) - 1) * interval });
  }
  return start;
}

/**
 * Expand local wall-clock RRULE occurrences with Luxon's IANA tzdata. The
 * callback form of `between` stops hostile high-frequency expansion at a hard
 * scan ceiling instead of first materialising an unbounded array.
 */
export function occurrences(
  schedule: Pick<DigestSchedule, 'rrule' | 'dtstart' | 'timeZone'>,
  from: Date,
  until: Date,
  limit = 100,
): Date[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OCCURRENCE_LIMIT) {
    return invalidSchedule('invalid occurrence limit');
  }
  if (!(from instanceof Date) || !(until instanceof Date)
    || !Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime())) {
    return invalidSchedule('invalid occurrence bounds');
  }
  if (from.getTime() > until.getTime()) return [];
  const start = DateTime.fromISO(schedule.dtstart, { zone: schedule.timeZone });
  if (!start.isValid) return invalidSchedule('invalid dtstart');
  let parsed;
  try {
    parsed = rrulestr(`RRULE:${canonicalRRule(schedule.rrule)}`);
  } catch {
    return invalidSchedule('invalid rrule');
  }
  if (!(parsed instanceof RRule)) return invalidSchedule('invalid rrule');

  // RRULE operates on floating wall-clock values. Keep DTSTART's local
  // components, then map each generated wall value through tzdata below.
  const absoluteUntil = parsed.origOptions.until;
  const effectiveUntil = absoluteUntil && absoluteUntil < until ? absoluteUntil : until;
  if (effectiveUntil < from) return [];
  const scanStart = recurrenceScanStart(start, from, parsed, schedule.timeZone);
  const floating = new RRule(preserveOriginalCalendarAnchor(
    { ...parsed.origOptions, until: null, dtstart: wallClockDate(scanStart) },
    start,
  ));
  const floatingFrom = new Date(Date.UTC(scanStart.year, scanStart.month - 1, scanStart.day));
  // An IANA offset can cross a date boundary. The extra two days keep a
  // boundary occurrence from being dropped without making the window open-ended.
  const floatingUntil = new Date(Math.min(8_640_000_000_000_000, effectiveUntil.getTime() + 2 * 86_400_000));
  const out: Date[] = [];
  let scanned = 0;
  let exceededScan = false;
  floating.between(floatingFrom, floatingUntil, true, (wall) => {
    scanned += 1;
    if (scanned > MAX_OCCURRENCE_SCAN) {
      exceededScan = true;
      return false;
    }
    const point = DateTime.fromJSDate(wall, { zone: 'UTC' });
    const local = DateTime.fromObject({
      year: point.year,
      month: point.month,
      day: point.day,
      hour: point.hour,
      minute: point.minute,
      second: point.second,
      millisecond: point.millisecond,
    }, { zone: schedule.timeZone });
    // Luxon shifts spring-forward gaps to a valid wall time and exposes both
    // offsets for a fall-back fold.
    for (const candidate of local.getPossibleOffsets()) {
      const instant = candidate.toUTC().toJSDate();
      if (instant >= from && instant <= effectiveUntil
        && !out.some((item) => item.getTime() === instant.getTime())) {
        out.push(instant);
        if (out.length >= limit) return false;
      }
    }
    return true;
  });
  if (exceededScan) return invalidSchedule('rrule expansion exceeds bounded scan');
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export function occurrenceKey(instant: Date): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    return invalidSchedule('invalid occurrence');
  }
  return instant.toISOString();
}

export function catchUpOccurrences(
  schedule: Pick<DigestSchedule, 'rrule' | 'dtstart' | 'timeZone' | 'catchUpPolicy' | 'maxCatchUp'>,
  now: Date,
): Date[] {
  if (schedule.catchUpPolicy === 'skip' || schedule.maxCatchUp < 1) return [];
  const start = new Date(schedule.dtstart);
  if (!Number.isFinite(start.getTime()) || now.getTime() < start.getTime()) return [];
  const all = occurrences(
    schedule,
    catchUpScanStart(schedule, start, now),
    now,
    // The look-back margin may contain more than the requested quota when a
    // BYDAY/BYMONTH filter is sparse. Collect a bounded page, then retain only
    // the newest quota so the occurrence at `now` is never dropped.
    MAX_OCCURRENCE_LIMIT,
  );
  return all.slice(Math.max(0, all.length - schedule.maxCatchUp));
}

/** Bound catch-up scans by the requested quota rather than the schedule age. */
function catchUpScanStart(
  schedule: Pick<DigestSchedule, 'rrule' | 'timeZone' | 'maxCatchUp'>,
  originalStart: Date,
  now: Date,
): Date {
  const rule = canonicalRRule(schedule.rrule);
  const frequency = /(?:^|;)FREQ=([A-Z]+)/u.exec(rule)?.[1];
  const interval = Number(/(?:^|;)INTERVAL=(\d+)/u.exec(rule)?.[1] ?? 1);
  // BYDAY/BYMONTH filters can make a nominally daily/monthly rule sparse
  // (for example, two Monday occurrences may be more than two periods apart).
  // Leave a generous bounded margin while the recurrence iterator itself
  // remains capped by MAX_OCCURRENCE_SCAN.
  const periods = Math.max(1, schedule.maxCatchUp + 1)
    * Math.max(1, interval) * 8;
  const localNow = DateTime.fromJSDate(now, { zone: schedule.timeZone });
  if (!localNow.isValid) return originalStart;
  let candidate = localNow;
  if (frequency === 'YEARLY') candidate = localNow.minus({ years: periods + 1 });
  else if (frequency === 'MONTHLY') candidate = localNow.minus({ months: periods + 1 });
  else if (frequency === 'WEEKLY') candidate = localNow.minus({ weeks: periods + 1 });
  else if (frequency === 'DAILY') candidate = localNow.minus({ days: periods + 1 });
  else if (frequency === 'HOURLY') candidate = localNow.minus({ hours: periods + 1 });
  else if (frequency === 'MINUTELY') candidate = localNow.minus({ minutes: periods + 1 });
  else if (frequency === 'SECONDLY') candidate = localNow.minus({ seconds: periods + 1 });
  const candidateDate = candidate.toUTC().toJSDate();
  return candidateDate.getTime() > originalStart.getTime() ? candidateDate : originalStart;
}

function uuidFromDigest(input: string): string {
  const bytes = createHash('sha256').update(input, 'utf8').digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function deterministicRunIdentity(
  scheduleId: string,
  instant: Date,
): { occurrenceKey: string; issueKey: string; commandId: string } {
  if (typeof scheduleId !== 'string' || scheduleId.length < 1 || scheduleId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(scheduleId)) {
    return invalidSchedule('invalid schedule id');
  }
  const key = occurrenceKey(instant);
  const issueKey = `${scheduleId}:${key}`;
  if (issueKey.length > 128) return invalidSchedule('occurrence identity is too long');
  return { occurrenceKey: key, issueKey, commandId: uuidFromDigest(`${scheduleId}:${key}`) };
}

export interface ScheduleMutationInput {
  readonly actor: ReportActor;
  readonly commandId: string;
  readonly seriesId: string;
  readonly expectedRevision?: string;
  readonly schedule: ScheduleInput;
}

export async function upsertDigestSchedule(
  uow: ReportUnitOfWork,
  input: ScheduleMutationInput,
): Promise<ReportMutationResult<DigestSchedule>> {
  return uow.execute(async (ports) => {
    if (!ports.schedules) throw new Error('schedule unavailable');
    assertActor(input);
    try {
      assertCanonicalCommandId(input.commandId);
    } catch {
      throw new ReportsApplicationError('invalid_request', 'invalid command id');
    }
    const binding = {
      principalId: input.actor.principalId,
      commandScope: 'reports.schedule.upsert',
      commandId: input.commandId,
    };
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ scope: binding.commandScope, actor: input.actor.principalId, body: input }), 'utf8')
      .digest('hex');
    const claim = await ports.receipts.claim(binding, fingerprint);
    if (claim.kind === 'replay') return { kind: 'replay', result: claim.result };
    if (claim.kind === 'in_progress' || claim.kind === 'expired' || claim.kind === 'reused') return claim;
    const series = await ports.series.lockById(input.seriesId);
    if (!series || series.state === 'archived') {
      // Do not commit an in_progress receipt for a missing/archived target.
      // Throwing rolls the claim back atomically and lets the caller receive a
      // generic resource-not-found response instead of a permanently stuck
      // command receipt.
      throw new ReportsApplicationError('resource_not_found', 'report series not found');
    }
    if (series.ownerSubjectId !== input.actor.subjectId) throw new ReportsApplicationError('forbidden', 'owner only');
    const normalized = normalizeSchedule(input.schedule);
    const current = await ports.schedules.get(series.id);
    if (!current && input.expectedRevision !== undefined) {
      throw new ReportsApplicationError('precondition_failed', 'schedule does not exist');
    }
    if (current && !input.expectedRevision) {
      throw new ReportsApplicationError('precondition_failed', 'schedule revision is required');
    }
    if (input.expectedRevision && current
      && !ports.revision.matches(current.resourceRevision, input.expectedRevision)) {
      throw new ReportsApplicationError('precondition_failed', 'schedule revision mismatch');
    }
    const value: DigestSchedule = {
      id: current?.id ?? randomUUID(),
      seriesId: series.id,
      enabled: true,
      ...normalized,
      nextRunAt: null,
      resourceRevision: ports.revision.next(),
    };
    const saved = await ports.schedules.upsert(value);
    const at = await clockNow(ports);
    await ports.audit.append({
      eventId: ports.ids.nextEventId(),
      principalId: input.actor.principalId,
      principalType: 'subject',
      seriesId: series.id,
      action: 'schedule.upserted',
      changed: { resourceRevision: saved.resourceRevision, enabled: saved.enabled },
      occurredAt: at,
      details: {},
    });
    await ports.receipts.complete(binding, fingerprint, {
      status: 200,
      body: Buffer.from(JSON.stringify(saved)),
      stableHeaders: { 'content-type': 'application/json', 'etag': `"${saved.resourceRevision}"` },
      mediaType: 'application/json',
      contractVersion: 'reports.v1',
      targetIdentity: saved.seriesId,
    });
    return { kind: 'succeeded', value: saved };
  });
}

export async function deleteDigestSchedule(
  uow: ReportUnitOfWork,
  input: Omit<ScheduleMutationInput, 'schedule'>,
): Promise<ReportMutationResult<null>> {
  return uow.execute(async (ports) => {
    if (!ports.schedules) throw new Error('schedule unavailable');
    if (!OPAQUE_ID.test(input.seriesId)
      || typeof input.actor.principalId !== 'string' || !ACTOR_ID.test(input.actor.principalId)
      || typeof input.actor.subjectId !== 'string' || !ACTOR_ID.test(input.actor.subjectId)) {
      throw new ReportsApplicationError('invalid_request', 'report identity is invalid');
    }
    try {
      assertCanonicalCommandId(input.commandId);
    } catch {
      throw new ReportsApplicationError('invalid_request', 'invalid command id');
    }
    const binding = {
      principalId: input.actor.principalId,
      commandScope: 'reports.schedule.delete',
      commandId: input.commandId,
    };
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ scope: binding.commandScope, actor: input.actor.principalId, body: input }), 'utf8')
      .digest('hex');
    const claim = await ports.receipts.claim(binding, fingerprint);
    if (claim.kind === 'replay') return { kind: 'replay', result: claim.result };
    if (claim.kind === 'in_progress' || claim.kind === 'expired' || claim.kind === 'reused') return claim;
    const series = await ports.series.lockById(input.seriesId);
    if (!series || series.ownerSubjectId !== input.actor.subjectId) throw new ReportsApplicationError('resource_not_found', 'report not found');
    const current = await ports.schedules.get(series.id);
    if (current && !input.expectedRevision) throw new ReportsApplicationError('precondition_failed', 'schedule revision is required');
    if (current && input.expectedRevision && !ports.revision.matches(current.resourceRevision, input.expectedRevision)) {
      throw new ReportsApplicationError('precondition_failed', 'schedule revision mismatch');
    }
    await ports.schedules.disable(series.id, current ? ports.revision.next() : undefined);
    const at = await clockNow(ports);
    await ports.audit.append({
      eventId: ports.ids.nextEventId(),
      principalId: input.actor.principalId,
      principalType: 'subject',
      seriesId: series.id,
      action: 'schedule.deleted',
      changed: { hadSchedule: current !== null },
      occurredAt: at,
      details: {},
    });
    await ports.receipts.complete(binding, fingerprint, {
      status: 204,
      body: Buffer.alloc(0),
      stableHeaders: {},
      mediaType: '',
      contractVersion: 'reports.v1',
      targetIdentity: series.id,
    });
    return { kind: 'succeeded', value: null };
  });
}
