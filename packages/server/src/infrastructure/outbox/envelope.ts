export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ClosedPayload = Readonly<Record<string, JsonValue>>;

export interface AggregateIdentity {
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_scope: string | null;
}

export interface VersionedEventEnvelope<Payload extends ClosedPayload = ClosedPayload> {
  readonly event_id: string;
  readonly event_type: string;
  readonly event_version: number;
  readonly aggregate_identity: AggregateIdentity;
  readonly aggregate_revision: string | null;
  readonly commit_ordinal: string | null;
  readonly occurred_at: string;
  readonly payload: Payload;
}

export class UnsupportedEventVersionError extends Error {
  constructor(readonly eventType: string, readonly eventVersion: number) {
    super(`unsupported outbox event: ${eventType}@${eventVersion}`);
    this.name = 'UnsupportedEventVersionError';
  }
}

export class InvalidEventEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventEnvelopeError';
  }
}

export type PayloadValidator = (payload: unknown) => payload is ClosedPayload;

export interface EventPayloadRegistration {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly validatePayload: PayloadValidator;
}

const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9._~:-]{0,255}$/;
const REVISION = /^[A-Za-z0-9._~-]{1,128}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UTC_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InvalidEventEnvelopeError(`${name} must be a closed object`);
  }
}

function assertString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new InvalidEventEnvelopeError(`${name} must be a non-empty string of at most ${max} characters`);
  }
}

export class EventEnvelopeRegistry {
  private readonly validators: ReadonlyMap<string, PayloadValidator>;

  constructor(registrations: readonly EventPayloadRegistration[]) {
    const validators = new Map<string, PayloadValidator>();
    for (const registration of registrations) {
      assertString(registration.eventType, 'eventType', 128);
      if (!Number.isInteger(registration.eventVersion) || registration.eventVersion < 1) {
        throw new TypeError('eventVersion must be a positive integer');
      }
      const key = this.key(registration.eventType, registration.eventVersion);
      if (validators.has(key)) throw new TypeError(`duplicate event payload registration: ${key}`);
      validators.set(key, registration.validatePayload);
    }
    this.validators = validators;
  }

  validate(value: unknown): VersionedEventEnvelope {
    if (!isRecord(value)) throw new InvalidEventEnvelopeError('event envelope must be an object');
    assertExactKeys(value, [
      'event_id', 'event_type', 'event_version', 'aggregate_identity', 'aggregate_revision',
      'commit_ordinal', 'occurred_at', 'payload',
    ], 'event envelope');
    assertString(value.event_id, 'event_id', 256);
    assertString(value.event_type, 'event_type', 128);
    if (!IDENTIFIER.test(value.event_id)) throw new InvalidEventEnvelopeError('event_id is invalid');
    if (!Number.isInteger(value.event_version) || (value.event_version as number) < 1) {
      throw new InvalidEventEnvelopeError('event_version must be a positive integer');
    }
    if (!isRecord(value.aggregate_identity)) {
      throw new InvalidEventEnvelopeError('aggregate_identity must be an object');
    }
    assertExactKeys(
      value.aggregate_identity,
      ['aggregate_type', 'aggregate_id', 'aggregate_scope'],
      'aggregate_identity',
    );
    assertString(value.aggregate_identity.aggregate_type, 'aggregate_type', 64);
    assertString(value.aggregate_identity.aggregate_id, 'aggregate_id', 256);
    if (value.aggregate_identity.aggregate_scope !== null) {
      assertString(value.aggregate_identity.aggregate_scope, 'aggregate_scope', 256);
    }
    if (value.aggregate_revision !== null
      && (typeof value.aggregate_revision !== 'string' || !REVISION.test(value.aggregate_revision))) {
      throw new InvalidEventEnvelopeError('aggregate_revision is invalid');
    }
    if (value.commit_ordinal !== null
      && (typeof value.commit_ordinal !== 'string' || !DECIMAL.test(value.commit_ordinal))) {
      throw new InvalidEventEnvelopeError('commit_ordinal must be a decimal string or null');
    }
    if (typeof value.occurred_at !== 'string'
      || !UTC_RFC3339.test(value.occurred_at)
      || Number.isNaN(Date.parse(value.occurred_at))) {
      throw new InvalidEventEnvelopeError('occurred_at must be an RFC3339 UTC date-time');
    }
    const version = value.event_version as number;
    const validator = this.validators.get(this.key(value.event_type, version));
    if (!validator) throw new UnsupportedEventVersionError(value.event_type, version);
    if (!validator(value.payload)) {
      throw new InvalidEventEnvelopeError(`invalid closed payload for ${value.event_type}@${version}`);
    }
    return value as unknown as VersionedEventEnvelope;
  }

  get isEmpty(): boolean {
    return this.validators.size === 0;
  }

  private key(eventType: string, eventVersion: number): string {
    return `${eventType}\u0000${eventVersion}`;
  }
}

export function defineClosedPayloadValidator(
  fields: Readonly<Record<string, (value: unknown) => boolean>>,
): PayloadValidator {
  const expected = Object.keys(fields).sort();
  return (payload: unknown): payload is ClosedPayload => {
    if (!isRecord(payload)) return false;
    const actual = Object.keys(payload).sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index])
      && expected.every((key) => fields[key]?.(payload[key]) === true);
  };
}

/**
 * Type-level fixtures (verified by `npm run typecheck`): if `JsonValue` is
 * widened, the @ts-expect-error directives below become unused and the
 * typecheck fails, proving function/Date/undefined cannot enter a closed
 * outbox payload.
 */
function closedPayloadTypeFixtures(): void {
  // @ts-expect-error a function value cannot enter a closed outbox payload
  const _functionPayload: ClosedPayload = { fn: () => 1 };
  // @ts-expect-error a Date instance cannot enter a closed outbox payload
  const _datePayload: ClosedPayload = { at: new Date() };
  // @ts-expect-error an undefined value cannot enter a closed outbox payload
  const _undefinedPayload: ClosedPayload = { missing: undefined };
}
