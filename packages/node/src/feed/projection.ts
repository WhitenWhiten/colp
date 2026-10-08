import {
  projectPublicationPublicWire,
  PublicationPublicProjectionError,
  type PublicationPublicWireOptions,
  type PublicationPublicValue,
} from '../server/publication-public-projection.js';
import { immutableJsonSnapshot } from '../shared/immutable-json.js';
import { projectFeedNodeBookmark } from './bookmark-url.js';
import { discriminateFeedEvent } from './event-contracts.js';
import type { ValidatorRegistry } from '../schema/index.js';
import { assertAnonymousPublicationPrimaryVisibility } from '../server/publication-anonymous-visibility.js';

export type FeedProjectionResult =
  | { readonly ok: true; readonly value: PublicationPublicValue }
  | { readonly ok: false; readonly code: FeedProjectionErrorCode };

export type FeedProjectionErrorCode =
  | 'malformed_input'
  | 'event_contract_failed'
  | 'projection_failed'
  | 'partial_projection';

export interface FeedProjectionOptions extends PublicationPublicWireOptions {
  readonly validators?: ValidatorRegistry;
  readonly bookmarkMode?: 'omit' | 'redact';
}

/**
 * Projects a Feed Event (or event `data`) for public/authorized outbound wire
 * (FEED-0003).
 *
 * Reuses Publication public projection so private sidecars, credentials, native
 * IDs, and unsafe extensions cannot appear. Failures are fail-closed: no
 * partial-success projection is returned.
 */
export function projectFeedEvent(
  input: unknown,
  options: FeedProjectionOptions = {},
): FeedProjectionResult {
  let snapshot: unknown;
  try {
    snapshot = immutableJsonSnapshot(input, 'Feed projection input');
  } catch {
    // Preserve FEED-0003's deterministic projection failure contract for
    // snapshot/limit failures while still ensuring no untrusted value is read.
    return Object.freeze({ ok: false, code: 'projection_failed' });
  }

  try {
    if (!isPlainObject(snapshot)) {
      return Object.freeze({ ok: false, code: 'malformed_input' });
    }

    // Full CloudEvent envelope: validate discriminant first, then project.
    if (typeof snapshot.type === 'string' && snapshot.data !== undefined) {
      const discriminated = discriminateFeedEvent(snapshot, options.validators);
      if (!discriminated.valid) {
        return Object.freeze({ ok: false, code: 'event_contract_failed' });
      }
      const event = structuredClone(discriminated.event) as unknown as Record<string, unknown>;
      const data = event.data as Record<string, unknown>;
      if (isPlainObject(data.node)) {
        data.node = projectFeedNodeBookmark(data.node, {
          mode: options.bookmarkMode ?? 'omit',
        });
      }
      const projected = projectPublicationPublicWire(event, toWireOptions(options));
      assertAnonymousPublicationPrimaryVisibility(projected);
      assertNoForbiddenFeedFields(projected);
      return Object.freeze({ ok: true, value: projected });
    }

    // Bare event data / node payload path.
    const clone = structuredClone(snapshot) as Record<string, unknown>;
    // Check authoritative visibility before Bookmark projection can discard
    // the source node's collection and visibility fields.  A bare Feed value
    // has no event contract that can provide an effective-visibility proof;
    // an inherited or restricted primary Node must therefore fail closed.
    assertAnonymousPublicationPrimaryVisibility(clone);
    if (isPlainObject(clone.node)) {
      clone.node = projectFeedNodeBookmark(clone.node, {
        mode: options.bookmarkMode ?? 'omit',
      });
    }
    const projected = projectPublicationPublicWire(clone, toWireOptions(options));
    assertAnonymousPublicationPrimaryVisibility(projected);
    assertNoForbiddenFeedFields(projected);
    return Object.freeze({ ok: true, value: projected });
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) {
      return Object.freeze({ ok: false, code: 'projection_failed' });
    }
    return Object.freeze({ ok: false, code: 'projection_failed' });
  }
}

/**
 * Projects an ordered list of Feed Events. Any single failure fails the whole
 * page closed (no partial-success list).
 */
export function projectFeedEvents(
  events: unknown,
  options: FeedProjectionOptions = {},
): FeedProjectionResult {
  let snapshot: unknown;
  try {
    snapshot = immutableJsonSnapshot(events, 'Feed projection events');
  } catch {
    return Object.freeze({ ok: false, code: 'malformed_input' });
  }
  if (!Array.isArray(snapshot)) {
    return Object.freeze({ ok: false, code: 'malformed_input' });
  }
  const projected: PublicationPublicValue[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    const result = projectFeedEvent(snapshot[index], options);
    if (!result.ok) {
      return Object.freeze({ ok: false, code: 'partial_projection' });
    }
    projected.push(result.value);
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze(projected) as PublicationPublicValue,
  });
}

const FORBIDDEN_SUBSTRINGS = Object.freeze([
  'password',
  'secret',
  'credential',
  'apikey',
  'accesskey',
  'nativesourceid',
  'nativesource',
  'localpath',
  'filepath',
  'sidecar',
]);

function assertNoForbiddenFeedFields(value: PublicationPublicValue, path = ''): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenFeedFields(value[i] as PublicationPublicValue, `${path}/${i}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_\-\s]/gu, '');
    if (FORBIDDEN_SUBSTRINGS.some((item) => normalized.includes(item))) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    assertNoForbiddenFeedFields(child as PublicationPublicValue, `${path}/${key}`);
  }
}

function toWireOptions(options: FeedProjectionOptions): PublicationPublicWireOptions {
  return {
    ...(options.publicExtensionNamespaces === undefined
      ? {}
      : { publicExtensionNamespaces: options.publicExtensionNamespaces }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
