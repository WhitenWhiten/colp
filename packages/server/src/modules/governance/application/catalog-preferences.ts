import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';
import { CollectionPreconditionError, strongEntityTag } from '../../collections/index.js';
import {
  applyCatalogPreferencesPatch,
  emptyCatalogPreferences,
  governanceTimestamp,
  parseCatalogPreferencesPatch,
  type CatalogPreferencesPatch,
  type CatalogPreferencesView,
} from '../domain/catalog.js';

export const CATALOG_PREFERENCES_CONTRACT_VERSION = '1.0.0';
const VIRTUAL_REVISION = '1';

export interface CatalogPreferencesActor {
  readonly principalId: string;
  readonly accountId: string;
  readonly createdAt: Date;
}

export interface CatalogPreferencesStore {
  load(accountId: string): Promise<CatalogPreferencesView | null>;
  insertFirst(accountId: string, view: CatalogPreferencesView): Promise<'inserted' | 'conflict'>;
  updateIfRevision(
    accountId: string,
    expectedRevision: string,
    view: CatalogPreferencesView,
  ): Promise<boolean>;
}

export interface CatalogPreferencesPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly store: CatalogPreferencesStore;
  readonly clock: { now(): Promise<Date> };
}

export type { CatalogPreferencesView };

export type UpdateCatalogPreferencesResult =
  | { readonly kind: 'updated'; readonly preferences: CatalogPreferencesView }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
    }
  | { readonly kind: 'in_progress'; readonly retryAfterSeconds: number }
  | { readonly kind: 'reused' }
  | { readonly kind: 'expired'; readonly resultDigest: string | null };

function nextRevision(current: string): string {
  return String(BigInt(current) + 1n);
}

function wire(view: CatalogPreferencesView): CatalogPreferencesView {
  return Object.freeze({
    hiddenOwnerAccountIds: Object.freeze([...view.hiddenOwnerAccountIds]),
    hiddenTags: Object.freeze([...view.hiddenTags]),
    hiddenTitleKeywords: Object.freeze([...view.hiddenTitleKeywords]),
    preferredLanguages: Object.freeze([...view.preferredLanguages]),
    revision: view.revision,
    updatedAt: view.updatedAt,
  });
}

export function virtualCatalogPreferences(createdAt: Date): CatalogPreferencesView {
  return emptyCatalogPreferences(VIRTUAL_REVISION, governanceTimestamp(createdAt));
}

export async function getCatalogPreferences(
  store: CatalogPreferencesStore,
  actor: CatalogPreferencesActor,
): Promise<CatalogPreferencesView> {
  const stored = await store.load(actor.accountId);
  return stored ?? virtualCatalogPreferences(actor.createdAt);
}

export async function updateCatalogPreferences(
  ports: CatalogPreferencesPorts,
  input: {
    readonly actor: CatalogPreferencesActor;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly ifMatch: string;
    readonly patch: CatalogPreferencesPatch;
  },
): Promise<UpdateCatalogPreferencesResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const current = await getCatalogPreferences(ports.store, input.actor);
  const binding = {
    principalId: input.actor.principalId,
    commandScope: input.commandScope,
    commandId,
  };
  const claim = await ports.receipts.claim(binding, input.fingerprint);
  if (claim.kind === 'replay') {
    return {
      kind: 'replay',
      status: claim.result.status,
      body: claim.result.body,
      stableHeaders: claim.result.stableHeaders,
      mediaType: claim.result.mediaType,
    };
  }
  if (claim.kind !== 'claimed') return claim;
  if (input.ifMatch !== strongEntityTag(current.revision)) {
    throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
  }
  const now = await ports.clock.now();
  const next = applyCatalogPreferencesPatch(
    current,
    input.patch,
    nextRevision(current.revision),
    governanceTimestamp(now),
  );
  if (current.revision === VIRTUAL_REVISION) {
    const inserted = await ports.store.insertFirst(input.actor.accountId, next);
    if (inserted === 'conflict') {
      throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
    }
  } else {
    const updated = await ports.store.updateIfRevision(input.actor.accountId, current.revision, next);
    if (!updated) {
      throw new CollectionPreconditionError({ currentEtag: strongEntityTag(current.revision) });
    }
  }
  const bodyObject = {
    hiddenOwnerAccountIds: [...next.hiddenOwnerAccountIds],
    hiddenTags: [...next.hiddenTags],
    hiddenTitleKeywords: [...next.hiddenTitleKeywords],
    preferredLanguages: [...next.preferredLanguages],
    revision: next.revision,
    updatedAt: next.updatedAt,
  };
  const body = new TextEncoder().encode(JSON.stringify(bodyObject));
  const etag = strongEntityTag(next.revision);
  await ports.receipts.complete(binding, input.fingerprint, {
    status: 200,
    body,
    stableHeaders: {
      etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: CATALOG_PREFERENCES_CONTRACT_VERSION,
    targetIdentity: input.actor.accountId,
  });
  return { kind: 'updated', preferences: wire(next) };
}

export { parseCatalogPreferencesPatch };
