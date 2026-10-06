/**
 * Client-side advisory for the protocol SHOULD that a light Pull ought to
 * run before Push when an obvious conflict risk is already detectable.
 *
 * This helper is pure and fact-driven: hosts supply structured signals they
 * already observed (open conflicts, behind-server base, etc.). It does not
 * contact the network or invent heuristics from opaque wire payloads.
 */

/** Structured facts a host may already know before attempting Push. */
export interface LightPullAdvisoryFacts {
  /**
   * Count of open / unresolved conflict records known to the client.
   * Any positive value fails closed toward pull-first.
   */
  readonly openConflictCount?: number;
  /** Explicit boolean that open conflicts exist (host-computed). */
  readonly hasOpenConflicts?: boolean;
  /**
   * Conflict-kind events observed on the server since the client's last
   * successful Pull. Any positive value fails closed toward pull-first.
   */
  readonly conflictEventsSinceLastPull?: number;
  /**
   * True when the client's local base revision / cursor is known to lag the
   * server's current collection revision.
   */
  readonly localBaseBehindServer?: boolean;
  /**
   * Host-supplied catch-all when a more specific signal is not modeled yet
   * but conflict risk is already known to be material.
   */
  readonly obviousConflictRisk?: boolean;
}

export type LightPullAdvisory =
  | {
      readonly action: 'pull_first';
      readonly reason: string;
    }
  | {
      readonly action: 'push_ok';
      readonly reason: string;
    };

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPlainFacts(facts: LightPullAdvisoryFacts): void {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
    throw new TypeError('Light-pull advisory facts must be a plain object.');
  }
}

/**
 * Advises whether a client SHOULD perform a light Pull before Push.
 *
 * Fail-closed: any positive conflict signal or explicit risk flag yields
 * `{ action: 'pull_first' }`. Only a clean fact set yields `push_ok`.
 */
export function adviseLightPullBeforePush(facts: LightPullAdvisoryFacts): LightPullAdvisory {
  assertPlainFacts(facts);

  if (facts.openConflictCount !== undefined) {
    assertNonNegativeInteger(facts.openConflictCount, 'openConflictCount');
    if (facts.openConflictCount > 0) {
      return Object.freeze({
        action: 'pull_first' as const,
        reason: 'Open conflicts are present; pull and rebase before push.',
      });
    }
  }

  if (facts.hasOpenConflicts === true) {
    return Object.freeze({
      action: 'pull_first' as const,
      reason: 'Host reported open conflicts; pull and rebase before push.',
    });
  }

  if (facts.conflictEventsSinceLastPull !== undefined) {
    assertNonNegativeInteger(facts.conflictEventsSinceLastPull, 'conflictEventsSinceLastPull');
    if (facts.conflictEventsSinceLastPull > 0) {
      return Object.freeze({
        action: 'pull_first' as const,
        reason: 'Conflict events arrived since the last pull; pull before push.',
      });
    }
  }

  if (facts.localBaseBehindServer === true) {
    return Object.freeze({
      action: 'pull_first' as const,
      reason: 'Local base is behind the server revision; light pull before push.',
    });
  }

  if (facts.obviousConflictRisk === true) {
    return Object.freeze({
      action: 'pull_first' as const,
      reason: 'Host detected an obvious conflict risk; pull before push.',
    });
  }

  return Object.freeze({
    action: 'push_ok' as const,
    reason: 'No obvious conflict risk detected from supplied facts; push may proceed.',
  });
}
