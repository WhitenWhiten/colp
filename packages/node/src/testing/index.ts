import type { Clock, IdGenerator } from '../server/index.js';
import {
  createUnverifiedReplicaAuthProofForTests,
  type ReplicaAuthProof,
} from '../sync/replica-lifecycle.js';

export class FixedClock implements Clock {
  readonly #value: Date;

  constructor(value: Date | string) {
    this.#value = new Date(value);
  }

  now(): Date {
    return new Date(this.#value);
  }
}

export class SequenceIdGenerator implements IdGenerator {
  #sequence = 0;

  uuidV7(): string {
    this.#sequence += 1;
    return `test-id-${this.#sequence}`;
  }
}

/**
 * **Dangerous test-only** Replica auth proof. Never use on production hosts.
 * Production code must mint proofs via `createReplicaAuthProofFromVerifiedSession`
 * or explicit `assertReplicaCallerAuthenticated({ authenticated: true, source: 'host-verified' })`.
 */
export function createTestReplicaAuthProof(): ReplicaAuthProof {
  return createUnverifiedReplicaAuthProofForTests();
}

export { createUnverifiedReplicaAuthProofForTests, type ReplicaAuthProof };

export {
  createInMemorySequenceUnitOfWork,
  createInMemorySyncSessionStore,
  type InMemorySequenceState,
  type InMemorySequenceUnitOfWork,
  type InMemorySyncSessionStore,
} from './sync-memory.js';
