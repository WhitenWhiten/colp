import type { DurableSyncEngineState } from './types.js';

/**
 * SR-06 defensive layer: the optional engine facts a recovery/direct write must carry
 * forward instead of re-deriving.
 *
 * `validateEngineState` treats every optional field as "omitted means dropped"
 * (`...(... === undefined ? {} : { ... })`): a caller that does not spell a field out
 * silently loses it. That is deliberate strictness, not an oversight - a repository
 * sweep that forgets a field should surface as a test-visible disappearance rather than
 * be papered over. Moving the inheritance into `validateEngineState` would turn that
 * omission into a silent pass-through, so the inheritance stays with the callers and is
 * shared from here instead.
 *
 * `sessionId` is intentionally absent: it has per-call-site semantics (a write may need
 * the Session it is rejecting rather than the prior one), so callers pass it explicitly.
 * `lastError` is absent for the same reason - every write here records its own reason.
 */
const INHERITED_ENGINE_FACTS = [
  'lastPublishedCursor',
  'lastAckedCursor',
  'lastPushServerCursor',
  'lastPushOutcomeHint',
  'localProjectionOwner',
  'connectivityConfirmationRevision',
] as const satisfies readonly (keyof DurableSyncEngineState)[];

export type InheritedEngineFacts = {
  [Key in (typeof INHERITED_ENGINE_FACTS)[number]]?: DurableSyncEngineState[Key];
};

/**
 * Returns exactly the prior facts a transition must re-state, each spread conditionally so
 * an absent fact stays absent (matching `durable-sync-engine.ts`'s `transition()` helper).
 * Spread the result into a `transitionEngine` / `put(validateEngineState(...))` input.
 */
export function inheritEngineFacts(prior: DurableSyncEngineState | null | undefined): InheritedEngineFacts {
  if (!prior) return {};
  return {
    ...(prior.lastPublishedCursor === undefined ? {} : { lastPublishedCursor: prior.lastPublishedCursor }),
    ...(prior.lastAckedCursor === undefined ? {} : { lastAckedCursor: prior.lastAckedCursor }),
    ...(prior.lastPushServerCursor === undefined ? {} : { lastPushServerCursor: prior.lastPushServerCursor }),
    ...(prior.lastPushOutcomeHint === undefined ? {} : { lastPushOutcomeHint: prior.lastPushOutcomeHint }),
    ...(prior.localProjectionOwner === undefined ? {} : { localProjectionOwner: prior.localProjectionOwner }),
    ...(prior.connectivityConfirmationRevision === undefined
      ? {} : { connectivityConfirmationRevision: prior.connectivityConfirmationRevision }),
  };
}

/**
 * Like {@link inheritEngineFacts}, but for a **freeze** write, which must release the
 * local-projection claim.
 *
 * `localProjectionOwner` is not a fact about what the replica has reached - it is a claim that the
 * engine revision named by the value is currently projecting locally. A freeze voids that claim:
 * the projector either failed (which is why the freeze happened) or is being superseded by
 * recovery. Two concrete reasons it cannot be carried forward:
 *
 *  - `resumeLocalProjection` releases the claim only while `current.revision === claimed.revision`.
 *    A freeze bumps the revision, so a retained owner can never be released again - it would pin
 *    ownership to a superseded revision for the life of the scope;
 *  - the projector's own failure contract ("a projector identity failure takes ownership away from
 *    local projection", `tests/local-projection-recovery.test.ts`) depends on the frozen row
 *    carrying no owner, and `resumeLocalProjection`'s early return keys on
 *    `recoveryFrozen && localProjectionOwner === undefined`.
 *
 * The five cursor/connectivity facts are unaffected: they record durable progress and must survive
 * the freeze (A-05 / S5). An *un*freeze (the evidence seed) keeps the claim and uses
 * {@link inheritEngineFacts} directly.
 */
export function inheritFrozenEngineFacts(prior: DurableSyncEngineState | null | undefined): InheritedEngineFacts {
  const { localProjectionOwner: _releasedClaim, ...facts } = inheritEngineFacts(prior);
  return facts;
}
