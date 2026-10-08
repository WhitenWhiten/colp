import {
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalOperationDigest,
  validateAuthoritativePullEvent,
} from '@know-n/colp/sync';
import type {
  AuthoritativeEffectPage,
  AuthoritativePullEffect,
  Operation,
} from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../identity/index.js';

export interface SyncEffectPageReadInput {
  readonly credential: VerifiedExtensionCredential;
  readonly sessionId: string;
  /** Transport Origin, bound to the durable Session when supplied by HTTP. */
  readonly origin?: string;
  readonly effectId: string;
  readonly pageNumber: number;
  /** One-version compatibility: claimed query identity must equal the Session row. */
  readonly collectionId?: string;
  readonly replicaId?: string;
}

export class SyncEffectPageReadError extends Error {
  // FIX-M-013 (SYNC-R08): `rate_limited` and `service_unavailable` are route
  // admission outcomes (429 / fail-closed 503) thrown before the reader.
  constructor(readonly code: 'not_found' | 'authentication_required' | 'integrity_failure'
    | 'payload_too_large' | 'rate_limited' | 'service_unavailable') {
    super(`Sync effect page read denied: ${code}`);
    this.name = 'SyncEffectPageReadError';
  }
}

export interface SyncEffectPageReadPort {
  read(input: SyncEffectPageReadInput): Promise<AuthoritativeEffectPage>;
}

export interface PersistedAuthoritativeEffectInput {
  readonly operation: Operation;
  readonly effect: AuthoritativePullEffect | Readonly<Record<string, unknown>>;
  readonly cursor: string;
  readonly effectPageAuthority?: string;
  readonly effectPageTemplate?: string;
}

export class SyncOperationEffectIntegrityError extends Error {
  constructor() {
    super('Authoritative operation effect integrity failure');
    this.name = 'SyncOperationEffectIntegrityError';
  }
}

export function validatePersistedAuthoritativeEffect(
  input: PersistedAuthoritativeEffectInput,
): AuthoritativePullEffect {
  try {
    const operationDigest = canonicalOperationDigest(input.operation);
    if (input.effect.operationDigest !== '' && input.effect.operationDigest !== operationDigest) {
      throw new Error('operation digest mismatch');
    }
    const candidate = { ...input.effect, operationDigest } as AuthoritativePullEffect;
    const effectDigest = canonicalAuthoritativeEffectDigest(candidate);
    if (input.effect.effectDigest !== '' && input.effect.effectDigest !== effectDigest) {
      throw new Error('effect digest mismatch');
    }
    const effect = { ...candidate, effectDigest } as AuthoritativePullEffect;
    const event = validateAuthoritativePullEvent({
      cursor: input.cursor, kind: 'operation', operation: input.operation, effect,
    } as never, '0.2', {
      ...(input.effectPageAuthority ? { effectPageAuthority: input.effectPageAuthority } : {}),
      ...(input.effectPageTemplate ? { effectPageTemplate: input.effectPageTemplate } : {}),
    });
    if (event.kind !== 'operation' || !('effect' in event)) throw new Error('invalid effect');
    return Object.freeze(structuredClone(event.effect)) as AuthoritativePullEffect;
  } catch (error) {
    if (error instanceof SyncOperationEffectIntegrityError) throw error;
    throw new SyncOperationEffectIntegrityError();
  }
}

export function buildAuthoritativeEffectPages(
  effectId: string,
  members: readonly string[],
  options: { readonly maxMembersPerPage?: number } = {},
): readonly AuthoritativeEffectPage[] {
  const maxMembersPerPage = options.maxMembersPerPage ?? 512;
  if (!Number.isSafeInteger(maxMembersPerPage) || maxMembersPerPage < 1 || maxMembersPerPage > 512) {
    throw new RangeError('Authoritative effect page member budget is invalid');
  }
  if (typeof effectId !== 'string' || effectId.length < 1 || effectId.length > 128) {
    throw new TypeError('Authoritative effect ID is invalid');
  }
  if (members.length < 1 || members.length > 524_288
      || members.some((member) => typeof member !== 'string' || member.length < 1 || member.length > 128)) {
    throw new RangeError('Authoritative effect members exceed the member budget');
  }
  if (new Set(members).size !== members.length) {
    throw new TypeError('Authoritative effect members contain a duplicate');
  }
  const pageCount = Math.ceil(members.length / maxMembersPerPage);
  const pages: AuthoritativeEffectPage[] = [];
  let previousPageDigest: string | null = null;
  for (let index = 0; index < pageCount; index += 1) {
    const pageMembers = members.slice(index * maxMembersPerPage, (index + 1) * maxMembersPerPage);
    const candidate: AuthoritativeEffectPage = {
      effectId, pageNumber: index + 1, pageCount, members: pageMembers,
      memberCount: pageMembers.length, pageDigest: '', previousPageDigest,
    };
    const page: AuthoritativeEffectPage = Object.freeze({ ...candidate,
      pageDigest: canonicalAuthoritativeEffectPageDigest(candidate) });
    pages.push(page);
    previousPageDigest = page.pageDigest;
  }
  return Object.freeze(pages);
}
