import type { ProductCommandBinding, ProductCommandClaim, ProductCommandReceiptPort, ProductCommandResult } from '../../commands/index.js';

export interface FolderShareView {
  readonly id: string; readonly collectionId: string; readonly nodeId: string;
  readonly slug: string; readonly createdAt: string;
}
export interface FolderShareState { readonly share: FolderShareView | null }
export class FolderShareError extends Error {
  constructor(readonly code: 'resource_not_found' | 'invalid_document' | 'publication_slug_conflict', message: string) {
    super(message); this.name = 'FolderShareError';
  }
}
export interface FolderSharePorts {
  readonly receipts: ProductCommandReceiptPort;
  /** Locks the owning collection and the live non-root folder, concealing foreign targets. */
  assertOwnerFolder(collectionId: string, nodeId: string, ownerSubjectId: string): Promise<void>;
  findLive(collectionId: string, nodeId: string): Promise<FolderShareView | null>;
  create(collectionId: string, nodeId: string): Promise<FolderShareView>;
  revoke(collectionId: string, nodeId: string): Promise<void>;
}
export interface FolderShareUnitOfWork {
  execute<T>(work: (ports: FolderSharePorts) => Promise<T>): Promise<T>;
}
export type FolderShareCommandOutcome = Exclude<ProductCommandClaim, { kind: 'claimed' }>;

export async function readFolderShare(ports: FolderSharePorts, input: {
  collectionId: string; nodeId: string; ownerSubjectId: string;
}): Promise<FolderShareState> {
  await ports.assertOwnerFolder(input.collectionId, input.nodeId, input.ownerSubjectId);
  return { share: await ports.findLive(input.collectionId, input.nodeId) };
}
export async function changeFolderShare(ports: FolderSharePorts, input: {
  collectionId: string; nodeId: string; ownerSubjectId: string;
  binding: ProductCommandBinding; fingerprint: string; action: 'share' | 'revoke';
}): Promise<FolderShareCommandOutcome> {
  await ports.assertOwnerFolder(input.collectionId, input.nodeId, input.ownerSubjectId);
  const claim = await ports.receipts.claim(input.binding, input.fingerprint);
  if (claim.kind !== 'claimed') return claim;
  let share: FolderShareView | null = null;
  if (input.action === 'share') share = await ports.findLive(input.collectionId, input.nodeId)
    ?? await ports.create(input.collectionId, input.nodeId);
  else await ports.revoke(input.collectionId, input.nodeId);
  const result: ProductCommandResult = { status: 200, body: Buffer.from(JSON.stringify({ share })),
    mediaType: 'application/json', contractVersion: '1.0.0',
    stableHeaders: { 'cache-control': 'private, no-store' }, targetIdentity: input.nodeId };
  await ports.receipts.complete(input.binding, input.fingerprint, result);
  return { kind: 'replay', result };
}
