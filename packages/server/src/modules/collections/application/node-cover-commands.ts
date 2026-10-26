import { randomUUID } from 'node:crypto';
import { evaluateAccess, type AccessPolicyFactsPort } from '../../access-policy/index.js';
import { assertCanonicalCommandId, canonicalCommandFingerprint, type ProductCommandReceiptPort,
  type ProductCommandResult } from '../../commands/index.js';
import { CollectionAuthorizationError } from '../domain/errors.js';
import { CoverImageError, imageAssetUrl, validateCoverImage, type CoverMode,
  type NodeCoverPreference } from './image-assets.js';
import type { CollectionWritePort } from './ports.js';

export interface NodeCoverStore {
  upload(input: { objectId: string; collectionId: string; subjectId: string; body: Buffer;
    mime: string; width: number; height: number; digest: string }): Promise<void>;
  findAsset(collectionId: string, assetId: string): Promise<NodeCoverPreference['image']>;
  findNode(collectionId: string, nodeId: string): Promise<boolean>;
  read(nodeId: string): Promise<NodeCoverPreference>;
  write(input: { collectionId: string; nodeId: string; mode: CoverMode; assetId: string | null }): Promise<NodeCoverPreference>;
}

export interface NodeCoverCommandPorts {
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly covers: NodeCoverStore;
}

export interface NodeCoverCommandUnitOfWork {
  execute<Result>(work: (ports: NodeCoverCommandPorts) => Promise<Result>): Promise<Result>;
}

type Actor = { readonly principalId: string; readonly subjectId: string };
type Input = { readonly actor: Actor; readonly commandId: string; readonly collectionId: string; readonly productOrigin: string };
export type CoverCommandOutcome =
  | { readonly kind: 'succeeded'; readonly status: number; readonly value: unknown }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' } | { readonly kind: 'expired' };

export function coverPreferenceView(preference: NodeCoverPreference, productOrigin: string) {
  return { mode: preference.mode, revision: preference.revision,
    image: preference.image ? { url: imageAssetUrl(productOrigin, preference.image.objectId),
      width: preference.image.width, height: preference.image.height } : null };
}

async function authorize(ports: NodeCoverCommandPorts, input: Input): Promise<void> {
  const collection = await ports.collections.lockForUpdate(input.collectionId);
  if (!collection || collection.deletedAt !== null) throw missing();
  const facts = await ports.accessPolicy.loadCollectionFacts({
    collectionId: input.collectionId, actorSubjectId: input.actor.subjectId,
  });
  if (!facts || (facts.ownerSubjectId !== input.actor.subjectId && facts.membershipRole === null)) throw missing();
  const decision = evaluateAccess(facts, { ...input.actor, kind: 'account' }, 'update_node');
  if (decision.outcome !== 'allow') throw new CollectionAuthorizationError({
    outcome: decision.outcome, reasonCategory: decision.reasonCategory,
  });
}

function missing(): CollectionAuthorizationError {
  return new CollectionAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
}

async function command(
  ports: NodeCoverCommandPorts, input: Input, method: 'POST' | 'PUT', route: string, body: unknown,
  work: () => Promise<{ readonly status: number; readonly value: unknown }>,
): Promise<CoverCommandOutcome> {
  assertCanonicalCommandId(input.commandId);
  // Recheck current authority even when replaying a completed command.
  await authorize(ports, input);
  const binding = { principalId: input.actor.principalId, commandScope: route, commandId: input.commandId };
  const fingerprint = canonicalCommandFingerprint({ method, route, mediaType: 'application/json', body });
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind === 'replay') return { kind: 'replay', status: claim.result.status, body: claim.result.body,
    stableHeaders: claim.result.stableHeaders, mediaType: claim.result.mediaType };
  if (claim.kind !== 'claimed') return claim;
  const result = await work();
  const receipt: ProductCommandResult = { status: result.status, body: Buffer.from(JSON.stringify(result.value)),
    mediaType: 'application/json', contractVersion: '1.0.0',
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' } };
  await ports.receipts.complete(binding, fingerprint, receipt);
  return { kind: 'succeeded', ...result };
}

export async function uploadCollectionImage(
  ports: NodeCoverCommandPorts, input: Input & { readonly body: Buffer },
): Promise<CoverCommandOutcome> {
  const image = validateCoverImage(input.body);
  return command(ports, input, 'POST', `/api/v1/collections/${input.collectionId}/images`, image.digest, async () => {
    const objectId = randomUUID();
    await ports.covers.upload({ ...image, objectId, collectionId: input.collectionId,
      subjectId: input.actor.subjectId, body: input.body });
    return { status: 201, value: { assetId: objectId,
      image: { url: imageAssetUrl(input.productOrigin, objectId), width: image.width, height: image.height } } };
  });
}

export async function updateNodeCover(
  ports: NodeCoverCommandPorts,
  input: Input & { readonly nodeId: string; readonly mode: CoverMode; readonly assetId: string | null; readonly expectedRevision: string },
): Promise<CoverCommandOutcome> {
  const route = `/api/v1/collections/${input.collectionId}/nodes/${input.nodeId}/cover`;
  return command(ports, input, 'PUT', route,
    { mode: input.mode, assetId: input.assetId, expectedRevision: input.expectedRevision }, async () => {
      if (!await ports.covers.findNode(input.collectionId, input.nodeId)) throw missing();
      const previous = await ports.covers.read(input.nodeId);
      if (previous.revision !== input.expectedRevision) {
        throw new CoverImageError('precondition_failed', 'The cover changed. Refresh before trying again.');
      }
      if (input.assetId !== null && !await ports.covers.findAsset(input.collectionId, input.assetId)) throw missing();
      const preference = await ports.covers.write(input);
      return { status: 200, value: coverPreferenceView(preference, input.productOrigin) };
    });
}
