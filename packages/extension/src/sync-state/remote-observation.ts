import type { JsonObject, MountBindingRecord, MountPauseBaseline, RemoteObservationRecord } from './types.js';

export interface ObservationPauseBinding {
  readonly pauseGeneration: number;
  readonly pauseBoundaryVersion: string;
  readonly pauseCursor: string | null;
}

/** Pause identity for the detached window; opaque cursors are compared only by equality. */
export function observationPauseBinding(baseline: MountPauseBaseline | undefined): ObservationPauseBinding | undefined {
  if (!baseline) return undefined;
  return {
    pauseGeneration: baseline.generation,
    pauseBoundaryVersion: baseline.boundaryVersion,
    pauseCursor: baseline.lastAppliedCursor,
  };
}

export function pauseBindingForMapping(
  mapping: { readonly mountId?: string; readonly rootNativeId: string },
  mounts: readonly MountBindingRecord[],
): ObservationPauseBinding | Record<string, never> {
  const mount = mounts.find((item) => item.mountId === mapping.mountId || item.nativeRootId === mapping.rootNativeId);
  return observationPauseBinding(mount?.pauseBaseline) ?? {};
}

function pauseBindingOf(row: RemoteObservationRecord): ObservationPauseBinding | undefined {
  if (row.pauseGeneration === undefined || row.pauseBoundaryVersion === undefined || row.pauseCursor === undefined) {
    return undefined;
  }
  return {
    pauseGeneration: row.pauseGeneration,
    pauseBoundaryVersion: row.pauseBoundaryVersion,
    pauseCursor: row.pauseCursor,
  };
}

function pauseBindingsEqual(left: ObservationPauseBinding, right: ObservationPauseBinding): boolean {
  return left.pauseGeneration === right.pauseGeneration
    && left.pauseBoundaryVersion === right.pauseBoundaryVersion
    && left.pauseCursor === right.pauseCursor;
}

/** Valid only for the pause it was recorded under. Unbound leftovers are not current-pause facts. */
export function observationValidForPause(
  observation: RemoteObservationRecord, baseline: MountPauseBaseline | undefined,
): boolean {
  const bound = pauseBindingOf(observation);
  const expected = observationPauseBinding(baseline);
  return bound !== undefined && expected !== undefined && pauseBindingsEqual(bound, expected);
}

/** One remote snapshot per node: a content event must not erase its placement. */
export function mergeRemoteObservation(prior: RemoteObservationRecord | undefined, next: RemoteObservationRecord):
  RemoteObservationRecord {
  const left = prior ? pauseBindingOf(prior) : undefined;
  const right = pauseBindingOf(next);
  const inherit = prior !== undefined && ((left === undefined && right === undefined)
    || (left !== undefined && right !== undefined && pauseBindingsEqual(left, right)));
  const payload = { ...(inherit ? prior.payload : {}), ...next.payload };
  return { ...next, payload: next.kind === 'tombstone' ? { ...payload, deleted: true } : livePayload(payload) };
}

function livePayload(payload: JsonObject): JsonObject {
  if (payload.deleted !== true) return payload;
  const { deleted: _deleted, ...live } = payload;
  return live;
}
