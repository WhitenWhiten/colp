/**
 * The watchdog (S6, K6): the only thing that notices a stall nobody classified.
 *
 * Every other state in this extension is named by a code somebody wrote down.
 * A pass that never ends, an alarm that never fires, an upload that sits at the
 * head of the lane while the chip says "Syncing": none of those records an
 * error, so none of them would ever be told. This module measures two things
 * that do not depend on knowing why:
 *
 *   - the oldest change waiting to upload has not moved: the same change has
 *     been at the head of the lane for a while (`stuck`);
 *   - no pass has ended cleanly for a long time (`no_pass`).
 *
 * It speaks only when nothing else already explains the silence (paused,
 * offline, an error, a decision waiting, a first sync running), and only after
 * the condition has lasted a while, so a laptop waking from sleep or a browser
 * just started does not cry wolf before its first pass has had time to run.
 * Pure: the worker keeps the marker and supplies the facts.
 */

/** The oldest change waiting to upload has been at the head of the lane this long without moving. */
export const WATCHDOG_STUCK_AFTER_MS = 10 * 60_000;
/** No pass has ended cleanly for this long while nothing explains why. */
export const WATCHDOG_NO_PASS_AFTER_MS = 60 * 60_000;
/** A suspicion must last this long before it is told, so a resume from sleep is not mistaken for a stall. */
export const WATCHDOG_CONFIRM_AFTER_MS = 5 * 60_000;

export type WatchdogKind = 'stuck' | 'no_pass';

export interface WatchdogMarker {
  readonly version: 1;
  /** When a pass last ended cleanly (epoch milliseconds). */
  readonly lastPassAt?: number;
  /** The change at the head of the lane and when it was first seen there. */
  readonly head?: { readonly opId: string; readonly since: number };
  /** A condition that has held since this moment, not yet long enough to tell. */
  readonly suspect?: { readonly kind: WatchdogKind; readonly since: number };
}

export interface WatchdogFacts {
  readonly now: number;
  /** When this browser session began: a worker restart changes nothing, a browser restart resets every clock. */
  readonly sessionStart: number;
  /** Something else already says why nothing moves (paused, offline, an error, a decision, a first sync). */
  readonly explained: boolean;
  /** The change at the head of the lane, if any. */
  readonly head?: { readonly opId: string; readonly title?: string };
  /** When the engine last changed state, and whether that state is a clean end of a pass. */
  readonly engineUpdatedAt?: number;
  readonly passEnded: boolean;
}

export type WatchdogVerdict =
  | { readonly kind: 'stuck'; readonly since: number; readonly title?: string }
  | { readonly kind: 'no_pass'; readonly since: number };

export interface WatchdogResult {
  readonly marker: WatchdogMarker;
  readonly verdict?: WatchdogVerdict;
  /** When a pass last ended cleanly, for "last synced". */
  readonly lastSyncedAt?: number;
}

export function evaluateWatchdog(marker: WatchdogMarker | undefined, facts: WatchdogFacts): WatchdogResult {
  const { now } = facts;
  const lastPassAt = facts.passEnded && facts.engineUpdatedAt !== undefined
    ? Math.max(marker?.lastPassAt ?? 0, facts.engineUpdatedAt) : marker?.lastPassAt;
  // A change that is still at the head after the lane moved on has not moved: a new head is progress.
  const head = facts.head === undefined ? undefined
    : marker?.head?.opId === facts.head.opId ? marker.head : { opId: facts.head.opId, since: now };
  const stuckSince = head === undefined ? undefined : Math.max(head.since, facts.sessionStart);
  const passBase = Math.max(lastPassAt ?? 0, facts.sessionStart);
  let candidate: WatchdogVerdict | undefined;
  if (!facts.explained) {
    if (stuckSince !== undefined && now - stuckSince >= WATCHDOG_STUCK_AFTER_MS) {
      candidate = { kind: 'stuck', since: stuckSince, ...(facts.head?.title ? { title: facts.head.title } : {}) };
    } else if (now - passBase >= WATCHDOG_NO_PASS_AFTER_MS) {
      candidate = { kind: 'no_pass', since: passBase };
    }
  }
  const suspect = candidate === undefined ? undefined
    : marker?.suspect?.kind === candidate.kind ? marker.suspect : { kind: candidate.kind, since: now };
  const next: WatchdogMarker = { version: 1, ...(lastPassAt !== undefined ? { lastPassAt } : {}),
    ...(head ? { head } : {}), ...(suspect ? { suspect } : {}) };
  const told = candidate !== undefined && suspect !== undefined && now - suspect.since >= WATCHDOG_CONFIRM_AFTER_MS;
  return { marker: next, ...(told ? { verdict: candidate } : {}), ...(lastPassAt !== undefined ? { lastSyncedAt: lastPassAt } : {}) };
}

/** Whether the marker changed enough to be worth writing: the clock alone moves every pass, and a read is not a write. */
export function watchdogMarkerChanged(before: WatchdogMarker | undefined, after: WatchdogMarker): boolean {
  if (before === undefined) return true;
  return before.head?.opId !== after.head?.opId || before.suspect?.kind !== after.suspect?.kind
    || (after.lastPassAt ?? 0) - (before.lastPassAt ?? 0) >= 60_000;
}
