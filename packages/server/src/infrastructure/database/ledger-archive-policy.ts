export const ARCHIVE_OBJECT_STATES = Object.freeze(
  ['creating', 'verified', 'unavailable', 'deleted'] as const,
);
export const ARCHIVE_READ_STATES = Object.freeze(['disabled', 'verified', 'cutover'] as const);
export const ARCHIVE_HOT_SOURCE_STATES = Object.freeze(['attached', 'purging', 'detached'] as const);

export type ArchiveObjectState = (typeof ARCHIVE_OBJECT_STATES)[number];
export type ArchiveReadState = (typeof ARCHIVE_READ_STATES)[number];
export type ArchiveHotSourceState = (typeof ARCHIVE_HOT_SOURCE_STATES)[number];

export interface LedgerArchiveLifecycle {
  readonly objectState: ArchiveObjectState;
  readonly readState: ArchiveReadState;
  readonly hotSourceState: ArchiveHotSourceState;
}

export interface LedgerArchivePolicyInput extends LedgerArchiveLifecycle {
  readonly legalHold: boolean;
}

export interface LedgerArchivePolicy {
  readonly canReadObject: boolean;
  readonly canHydratePayload: boolean;
  readonly canCutoverReader: boolean;
  readonly canCutoverHot: boolean;
  readonly canPurgeHot: boolean;
  readonly canDetachHot: boolean;
  readonly canMarkDeletable: boolean;
  readonly canDeleteObject: boolean;
  readonly canAdvanceFloor: boolean;
  readonly canConfirmExport: boolean;
}

const LINEAR_LIFECYCLE = Object.freeze({
  open: { objectState: 'creating', readState: 'disabled', hotSourceState: 'attached' },
  sealed: { objectState: 'creating', readState: 'disabled', hotSourceState: 'attached' },
  exported: { objectState: 'creating', readState: 'disabled', hotSourceState: 'attached' },
  verified: { objectState: 'verified', readState: 'verified', hotSourceState: 'attached' },
  reader_cutover: { objectState: 'verified', readState: 'cutover', hotSourceState: 'attached' },
  detached: { objectState: 'verified', readState: 'cutover', hotSourceState: 'detached' },
  deletable: { objectState: 'verified', readState: 'cutover', hotSourceState: 'detached' },
  deleted: { objectState: 'deleted', readState: 'disabled', hotSourceState: 'detached' },
} as const);

export type LedgerArchiveLinearState = keyof typeof LINEAR_LIFECYCLE;

export function lifecycleFromLinearState(state: string): LedgerArchiveLifecycle {
  if (!Object.hasOwn(LINEAR_LIFECYCLE, state)) {
    throw new TypeError(`Archive linear state ${state} has no lifecycle mapping.`);
  }
  return Object.freeze({ ...LINEAR_LIFECYCLE[state as LedgerArchiveLinearState] });
}

export function parseLedgerArchiveLifecycle(input: {
  readonly objectState: unknown;
  readonly readState: unknown;
  readonly hotSourceState: unknown;
}): LedgerArchiveLifecycle {
  if (!isMember(ARCHIVE_OBJECT_STATES, input.objectState)
      || !isMember(ARCHIVE_READ_STATES, input.readState)
      || !isMember(ARCHIVE_HOT_SOURCE_STATES, input.hotSourceState)) {
    throw new TypeError('Archive lifecycle fields are not a known orthogonal triple.');
  }
  return Object.freeze({
    objectState: input.objectState, readState: input.readState, hotSourceState: input.hotSourceState,
  });
}

export function evaluateLedgerArchivePolicy(input: LedgerArchivePolicyInput): LedgerArchivePolicy {
  const lifecycle = parseLedgerArchiveLifecycle(input);
  const verifiedObject = lifecycle.objectState === 'verified';
  const readerOpen = lifecycle.readState === 'verified' || lifecycle.readState === 'cutover';
  const cutover = lifecycle.readState === 'cutover';
  const attached = lifecycle.hotSourceState === 'attached';
  const detached = lifecycle.hotSourceState === 'detached';
  const hold = input.legalHold === true;
  const canReadObject = verifiedObject && readerOpen;
  const canHydratePayload = verifiedObject && cutover;
  const canCutoverReader = verifiedObject && lifecycle.readState === 'verified' && attached && !hold;
  const canCutoverHot = verifiedObject && cutover && attached && !hold;
  const canMarkDeletable = verifiedObject && cutover && detached && !hold;
  const canAdvanceFloor = lifecycle.objectState === 'verified' || lifecycle.objectState === 'deleted';
  return Object.freeze({
    canReadObject,
    canHydratePayload,
    canCutoverReader,
    canCutoverHot,
    canPurgeHot: canCutoverHot,
    canDetachHot: canCutoverHot,
    canMarkDeletable,
    canDeleteObject: canMarkDeletable,
    canAdvanceFloor,
    canConfirmExport: canAdvanceFloor,
  });
}

export function evaluateLedgerArchivePolicyFromLinear(
  state: string,
  legalHold: boolean,
): LedgerArchivePolicy {
  return evaluateLedgerArchivePolicy({ ...lifecycleFromLinearState(state), legalHold });
}

export function lifecycleMatchesLinear(
  state: string,
  stored: LedgerArchiveLifecycle,
): boolean {
  const expected = lifecycleFromLinearState(state);
  return expected.objectState === stored.objectState
    && expected.readState === stored.readState
    && expected.hotSourceState === stored.hotSourceState;
}

function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
