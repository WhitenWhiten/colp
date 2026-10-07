import { createHash } from 'node:crypto';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  assertCanonicalCommandId,
  canonicalJson,
  type ProductCommandClaim,
  type ProductCommandReceiptPort,
  type ProductCommandResult,
} from '../../commands/index.js';

export const LIBRARY_ORDER_COMMAND_CONTRACT_VERSION = '1.0.0';
export const LIBRARY_ORDER_COMMAND_SCOPE = 'collections:library-order:v1';
/** The three orderable sidebar sections of the /library desk. */
export const LIBRARY_ORDER_SECTIONS = ['mine', 'shared', 'following'] as const;
export const LIBRARY_ORDER_MAX_ITEMS = 200;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export type LibraryOrderSection = (typeof LIBRARY_ORDER_SECTIONS)[number];

export class LibraryOrderCommandError extends Error {
  constructor(readonly code: 'invalid_request', message: string) {
    super(message);
    this.name = 'LibraryOrderCommandError';
  }
}

export interface LibraryOrderCommandInput {
  readonly actor: {
    readonly principalId: string;
    readonly subjectId: string;
  };
  readonly section: LibraryOrderSection;
  readonly collectionIds: readonly string[];
  readonly commandId: string;
}

export interface LibraryOrderSectionState {
  readonly section: LibraryOrderSection;
  readonly collectionIds: readonly string[];
}

export type LibraryOrderCommandResult =
  | { readonly kind: 'succeeded'; readonly order: LibraryOrderSectionState }
  | { readonly kind: 'replay'; readonly status: number; readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>; readonly mediaType: string;
      readonly contractVersion: string; readonly targetIdentity?: string }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

export interface LibraryOrderCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly orders: {
    save(entry: {
      readonly subjectId: string;
      readonly section: LibraryOrderSection;
      readonly collectionIds: readonly string[];
      readonly updatedAt: Date;
    }): Promise<void>;
  };
  readonly clock: { now(): Promise<Date> };
}

export interface LibraryOrderQueryPorts {
  readonly orders: {
    load(subjectId: string): Promise<readonly LibraryOrderSectionState[]>;
  };
}

export interface LibraryOrderView {
  readonly sections: Readonly<Record<LibraryOrderSection, readonly string[]>>;
}

/** Drop corrupt stored ids so GET cannot emit an invalid LibraryOrderView. */
export function sanitizeLibraryOrderIds(value: readonly unknown[]): readonly string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !OPAQUE_ID.test(entry) || seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry);
    if (next.length >= LIBRARY_ORDER_MAX_ITEMS) break;
  }
  return next;
}

export function libraryOrderCommandFingerprint(input: LibraryOrderCommandInput): string {
  const value = validateInput(input);
  return createHash('sha256').update(canonicalJson({
    actorPrincipalId: value.actor.principalId,
    actorSubjectId: value.actor.subjectId,
    collectionIds: value.collectionIds,
    contractVersion: LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
    section: value.section,
  }), 'utf8').digest('hex');
}

export async function updateLibraryOrder(
  ports: LibraryOrderCommandPorts,
  input: LibraryOrderCommandInput,
): Promise<LibraryOrderCommandResult> {
  const value = validateInput(input);
  const fingerprint = libraryOrderCommandFingerprint(value);
  const binding = {
    principalId: value.actor.principalId,
    commandScope: LIBRARY_ORDER_COMMAND_SCOPE,
    commandId: value.commandId,
  };
  const claim = await ports.receipts.claim(binding, fingerprint);
  if (claim.kind !== 'claimed') return mapClaim(claim);

  const now = await ports.clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new LibraryOrderCommandError('invalid_request', 'The command clock returned invalid time.');
  }
  await ports.orders.save({
    subjectId: value.actor.subjectId,
    section: value.section,
    collectionIds: value.collectionIds,
    updatedAt: now,
  });

  const order = Object.freeze({
    section: value.section,
    collectionIds: Object.freeze([...value.collectionIds]),
  });
  await ports.receipts.complete(binding, fingerprint, productResult(order));
  return { kind: 'succeeded', order };
}

export async function queryLibraryOrder(
  ports: LibraryOrderQueryPorts,
  input: { readonly subjectId: string },
): Promise<LibraryOrderView> {
  const stored = await ports.orders.load(input.subjectId);
  const sections: Record<LibraryOrderSection, readonly string[]> = {
    mine: [],
    shared: [],
    following: [],
  };
  for (const entry of stored) {
    if (!LIBRARY_ORDER_SECTIONS.includes(entry.section)) continue;
    sections[entry.section] = sanitizeLibraryOrderIds(entry.collectionIds);
  }
  return { sections };
}

function validateInput(input: LibraryOrderCommandInput): LibraryOrderCommandInput {
  if (!input || typeof input !== 'object' || !input.actor) {
    throw new LibraryOrderCommandError('invalid_request', 'Library order command input is required.');
  }
  for (const identity of [input.actor.principalId, input.actor.subjectId]) {
    if (typeof identity !== 'string' || identity.length < 1
        || identity.length > SOCIAL_IDENTITY_MAX_LENGTH
        || identity.trim() !== identity) {
      throw new LibraryOrderCommandError('invalid_request', 'Library order command identities are invalid.');
    }
  }
  if (!LIBRARY_ORDER_SECTIONS.includes(input.section)) {
    throw new LibraryOrderCommandError('invalid_request', 'The Library order section is unknown.');
  }
  if (!Array.isArray(input.collectionIds) || input.collectionIds.length > LIBRARY_ORDER_MAX_ITEMS) {
    throw new LibraryOrderCommandError('invalid_request', 'The Library order id list is invalid.');
  }
  for (const collectionId of input.collectionIds) {
    if (typeof collectionId !== 'string' || !OPAQUE_ID.test(collectionId)) {
      throw new LibraryOrderCommandError('invalid_request', 'The Library order id list is invalid.');
    }
  }
  if (new Set(input.collectionIds).size !== input.collectionIds.length) {
    throw new LibraryOrderCommandError('invalid_request', 'The Library order id list repeats a Collection.');
  }
  try {
    assertCanonicalCommandId(input.commandId);
  } catch {
    throw new LibraryOrderCommandError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return input;
}

function productResult(order: LibraryOrderSectionState): ProductCommandResult {
  const body = JSON.stringify({
    section: order.section,
    collectionIds: order.collectionIds,
  });
  return {
    status: 200,
    body: Buffer.from(body, 'utf8'),
    stableHeaders: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
    targetIdentity: order.section,
  };
}

function mapClaim(
  claim: Exclude<ProductCommandClaim, { readonly kind: 'claimed' }>,
): LibraryOrderCommandResult {
  if (claim.kind === 'replay') return { kind: 'replay', ...claim.result };
  if (claim.kind === 'in_progress' || claim.kind === 'expired') return claim;
  return { kind: 'reused' };
}
