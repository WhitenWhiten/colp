/** v1 conservative limits, independent of site API batch sizes. */
export const LIMITS = Object.freeze({
  observationBytes: 256 * 1024, pageBytes: 512 * 1024, responseBytes: 2 * 1024 * 1024,
  entities: 100, memberships: 64, id: 128, title: 512, url: 8192, cursor: 512,
  depth: 32, queue: 16, pendingObservations: 10_000, importItems: 50_000,
  leaseMs: 60_000, activationMs: 10_000, commandMs: 30_000, requestMs: 8_000,
  spacingMs: 1500, attempts: 3, backoffMs: 3000, maxAutomaticWaitMs: 10_000,
  idPages: 200, idsPerApiPage: 1000, detailsPerRequest: 100, cursorBuffers: 2,
});
