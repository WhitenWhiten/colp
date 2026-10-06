import { validatePublicationSnapshotReplacementSemantics } from '../semantic/index.js';
import type { SemanticIssue } from '../semantic/index.js';
import type { Snapshot } from '../types/index.js';

function deepFreeze<Value>(value: Value, visited = new WeakSet<object>()): Readonly<Value> {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  // Enumerate own string keys only (matches prior Object.values: no symbols / non-enumerable).
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key], visited);
  }
  return Object.freeze(value);
}

function immutableSnapshot(snapshot: Snapshot): Readonly<Snapshot> {
  return deepFreeze(structuredClone(snapshot) as Snapshot);
}

function detachedSnapshot(snapshot: Readonly<Snapshot>): Snapshot {
  return structuredClone(snapshot) as Snapshot;
}

export class PublicationSnapshotReplacementError extends TypeError {
  readonly issues: readonly SemanticIssue[];

  constructor(issues: readonly SemanticIssue[]) {
    super(`Publication Snapshot replacement rejected: ${issues[0]?.message ?? 'semantic validation failed'}`);
    this.name = 'PublicationSnapshotReplacementError';
    this.issues = issues;
  }
}

/** Owns one authoritative Publication Snapshot and commits replacements by one reference assignment. */
export class PublicationSnapshotState {
  #snapshot: Readonly<Snapshot> | undefined;
  /** Frozen view cached for {@link readOnlySnapshot}. Never the stored snapshot. */
  #readOnly: Readonly<Snapshot> | undefined;
  #readOnlySource: Readonly<Snapshot> | undefined;
  /** Start order of {@link refresh} calls; every call takes the next value. */
  #refreshGeneration = 0;
  /**
   * Start-order generation of the committed Snapshot. A load commits only when
   * it started after the committed one, so commits never go back in start order.
   */
  #committedGeneration = 0;
  /** Set only for the synchronous hand-off from {@link refresh} to {@link replace}. */
  #refreshCommitGeneration: number | undefined;

  get current(): Snapshot | undefined {
    return this.#snapshot === undefined ? undefined : detachedSnapshot(this.#snapshot);
  }

  /**
   * Deep-frozen read-only view of the committed Snapshot.
   *
   * The same reference is returned until the next successful replace, so a
   * consumer can read once and reuse it. It is a separate clone from internal
   * storage, not a live alias. {@link current} stays a fresh mutable detached copy.
   */
  get readOnlySnapshot(): Readonly<Snapshot> | undefined {
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return undefined;
    if (this.#readOnly === undefined || this.#readOnlySource !== snapshot) {
      this.#readOnly = immutableSnapshot(snapshot);
      this.#readOnlySource = snapshot;
    }
    return this.#readOnly;
  }

  replace(snapshot: Snapshot): Snapshot {
    // A refresh commits under its own start-order generation. An explicit
    // replacement is newer than every load already in flight.
    const generation = this.#refreshCommitGeneration ?? this.#refreshGeneration + 1;
    this.#refreshCommitGeneration = undefined;
    const replacement = this.#validatedCopy(snapshot);
    const result = detachedSnapshot(replacement);
    // Failed validation/copy above leaves the committed state and both counters intact.
    this.#refreshGeneration = Math.max(this.#refreshGeneration, generation);
    this.#committedGeneration = generation;
    this.#readOnly = undefined;
    this.#readOnlySource = undefined;
    this.#snapshot = replacement;
    return result;
  }

  #validatedCopy(snapshot: Snapshot): Readonly<Snapshot> {
    const validation = validatePublicationSnapshotReplacementSemantics(snapshot);
    if (!validation.valid) throw new PublicationSnapshotReplacementError(validation.issues);
    return immutableSnapshot(snapshot);
  }

  /**
   * Loads a Snapshot and commits it unless a load that started later (or an
   * explicit {@link replace}) has already committed.
   *
   * **Start-order fencing:** each call takes the next generation before invoking
   * `loader`. A completed load commits when its generation is newer than the
   * committed one. A slower earlier refresh therefore cannot overwrite a newer
   * commit, and a newer refresh that fails or is aborted does not discard an
   * earlier one that succeeds.
   *
   * **Superseded completion:** when something newer has committed, the loaded
   * Snapshot is not committed. For the same Collection the call returns a
   * detached copy of the newer committed Snapshot. For another Collection the
   * committed Snapshot says nothing about this one, so the call returns its own
   * validated load and leaves the committed state untouched.
   *
   * Loader rejection propagates unchanged and does not modify committed state.
   */
  async refresh(loader: () => Promise<Snapshot>): Promise<Snapshot> {
    const generation = ++this.#refreshGeneration;
    const snapshot = await loader();
    if (generation > this.#committedGeneration) {
      this.#refreshCommitGeneration = generation;
      try {
        return this.replace(snapshot);
      } finally {
        this.#refreshCommitGeneration = undefined;
      }
    }
    const current = this.current;
    if (current !== undefined && current.collection.id === snapshot.collection.id) return current;
    return detachedSnapshot(this.#validatedCopy(snapshot));
  }
}
