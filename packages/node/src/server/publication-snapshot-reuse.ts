/**
 * Proofs for publication snapshot planning and outbound preparation.
 * Entries are written only after this process completes the corresponding
 * check. Object.isFrozen is not consulted and cannot create an entry.
 */

export interface DeliveryObservation {
  readonly utf8Bytes: number;
  readonly objectCount: number;
}

export interface ProjectionCensus {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

interface OutboundProof {
  readonly key: string;
  readonly result: object;
}

const deliveryObservations = new WeakMap<object, DeliveryObservation>();
const schemaValidatedSnapshots = new WeakSet<object>();
const boundedPublicationGraphs = new WeakSet<object>();
const outboundProofs = new WeakMap<object, OutboundProof>();
const projectionCensuses = new WeakMap<object, ProjectionCensus>();

export const publicationReuseDiagnostics = {
  deliveryWalks: 0,
  deliveryReuses: 0,
  schemaValidations: 0,
  schemaReuses: 0,
  projectionValidations: 0,
  outboundReuses: 0,
  projectionCensusWalks: 0,
  projectionCensusReuses: 0,
  reset(): void {
    this.deliveryWalks = 0;
    this.deliveryReuses = 0;
    this.schemaValidations = 0;
    this.schemaReuses = 0;
    this.projectionValidations = 0;
    this.outboundReuses = 0;
    this.projectionCensusWalks = 0;
    this.projectionCensusReuses = 0;
  },
};

export function rememberDeliveryObservation(snapshot: object, observation: DeliveryObservation): void {
  deliveryObservations.set(snapshot, observation);
}

export function readDeliveryObservation(snapshot: object): DeliveryObservation | undefined {
  return deliveryObservations.get(snapshot);
}

export function rememberSchemaValidatedSnapshot(snapshot: object): void {
  schemaValidatedSnapshots.add(snapshot);
}

export function hasSchemaValidatedSnapshot(snapshot: object): boolean {
  return schemaValidatedSnapshots.has(snapshot);
}

export function rememberBoundedPublicationGraph(snapshot: object): void {
  boundedPublicationGraphs.add(snapshot);
}

export function hasBoundedPublicationGraph(snapshot: object): boolean {
  return boundedPublicationGraphs.has(snapshot);
}

export function rememberOutboundProof(snapshot: object, key: string, result: object): void {
  outboundProofs.set(snapshot, { key, result });
}

export function readOutboundProof(snapshot: object): OutboundProof | undefined {
  return outboundProofs.get(snapshot);
}

export function rememberProjectionCensus(snapshot: object, census: ProjectionCensus): void {
  projectionCensuses.set(snapshot, census);
}

export function readProjectionCensus(snapshot: object): ProjectionCensus | undefined {
  return projectionCensuses.get(snapshot);
}
