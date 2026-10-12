import { SCOPE_FIELDS, validateScope } from './sync-state/scope-key.js';
import type { SyncScope } from './sync-state-store.js';

/** Shared lifecycle for fields that Chrome cannot store on native bookmarks. */
export interface MetadataBinding<T> {
  readonly scopeKey: string;
  readonly resourceId: string;
  readonly revision: string;
  readonly value: T;
}
export interface MetadataAttempt<T> extends MetadataBinding<T> {
  readonly version: number;
  readonly eventId: string;
}
export interface MetadataField<T, Binding extends MetadataBinding<T> = MetadataBinding<T>> {
  readonly value: T;
  readonly version: number;
  readonly state: 'dirty' | 'synced';
  readonly remote?: Binding;
  readonly attempt?: MetadataAttempt<T>;
  readonly unboundBase?: T;
  readonly reviewVersion?: number;
}

/** The database is profile-local. Old builds rotated its profile id on logout;
 * accepting those old ids repairs stranded rows without crossing an account or collection. */
export function sameMetadataAuthority(a: string, b: string): boolean {
  if (a === b) return true;
  const left = metadataScope(a), right = metadataScope(b);
  return Boolean(left && right && ['environment', 'serverId', 'serverOrigin', 'accountId', 'collectionId']
    .every(field => left[field as keyof SyncScope] === right[field as keyof SyncScope]));
}

/** Stored attempt keys can reference a retired replica generation; reads remain scope-bound. */
export function metadataScope(key: string): SyncScope | null {
  try {
    const fields: unknown = JSON.parse(key);
    if (!Array.isArray(fields) || fields.length !== SCOPE_FIELDS.length) return null;
    return validateScope(Object.fromEntries(SCOPE_FIELDS.map((field, index) => [field, fields[index]])));
  } catch { return null; }
}

export function editMetadata<T, Binding extends MetadataBinding<T>>(previous: MetadataField<T, Binding> | undefined, value: T,
  empty: T, equal: (a: T, b: T) => boolean, force = false): MetadataField<T, Binding> {
  if (!force && previous && equal(previous.value, value)) return previous;
  return { ...previous, value, version: (previous?.version ?? 0) + 1,
    state: force || previous !== undefined || !equal(value, empty) ? 'dirty' : 'synced' };
}

export function observeMetadata<T, Binding extends MetadataBinding<T>>(previous: MetadataField<T, Binding> | undefined, binding: Binding,
  equal: (a: T, b: T) => boolean, settledVersion?: number): MetadataField<T, Binding> {
  // Keep profile-local data on sign-out, but never migrate it into another account/collection.
  if (previous?.remote && !sameMetadataAuthority(previous.remote.scopeKey, binding.scopeKey)) return previous;
  if (previous && (!previous.remote || previous.remote.resourceId !== binding.resourceId)) {
    const local = previous.value;
    const value = Array.isArray(local) && Array.isArray(binding.value)
      ? rebaseMetadataTags((previous.unboundBase ?? []) as string[], local, binding.value) as T
      : local === null || local === '' ? binding.value : local;
    const dirty = !equal(value, binding.value);
    const review = dirty && !Array.isArray(value) && binding.value !== null && binding.value !== '';
    const version = previous.version + Number(!equal(local, value));
    return { value, version, state: dirty ? 'dirty' : 'synced', remote: binding,
      ...(review ? { reviewVersion: version } : {}) };
  }
  if (previous?.reviewVersion !== undefined && previous.reviewVersion >= previous.version && !equal(previous.value, binding.value)) {
    return { ...previous, remote: binding };
  }
  const sameTarget = previous?.attempt?.resourceId === binding.resourceId
    && sameMetadataAuthority(previous.attempt.scopeKey, binding.scopeKey);
  const settled = sameTarget && settledVersion === previous?.attempt?.version;
  const echo = sameTarget && equal(previous!.attempt!.value, binding.value);
  const copied = previous?.remote && previous.remote.resourceId !== binding.resourceId
    && (Array.isArray(previous.value) ? previous.value.length > 0 : previous.value !== null && previous.value !== '');
  const dirty = Boolean(previous && (previous.state === 'dirty' || copied)
    && !equal(previous.value, binding.value) && (!settled || previous.version > settledVersion!));
  const remote = dirty && !echo && !settled && previous?.remote?.resourceId === binding.resourceId
    ? { ...previous.remote, scopeKey: binding.scopeKey } : binding;
  const value = dirty && previous ? previous.value : binding.value;
  return { value, version: (previous?.version ?? 0) + Number(!previous || !equal(previous.value, value)),
    state: dirty ? 'dirty' : 'synced', remote,
    ...(dirty && !echo && !settled && previous?.attempt ? { attempt: previous.attempt } : {}) };
}

export function metadataAttempt<T>(field: MetadataField<T>, binding: MetadataBinding<T>,
  equal: (a: T, b: T) => boolean, eventId?: string): MetadataAttempt<T> {
  const prior = field.attempt;
  const same = prior?.scopeKey === binding.scopeKey && prior.resourceId === binding.resourceId
    && prior.version === field.version && equal(prior.value, field.value);
  return { ...binding, value: field.value, version: field.version,
    eventId: eventId ?? (same ? prior.eventId : undefined) ?? crypto.randomUUID() };
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a), right = new Set(b);
  return left.size === right.size && [...left].every(tag => right.has(tag));
}

export function sameMetadataField<T>(a: MetadataField<T> | undefined, b: MetadataField<T>, equal: (a: T, b: T) => boolean): boolean {
  const bindingEqual = (left: MetadataBinding<T> | undefined, right: MetadataBinding<T> | undefined) => {
    if (!left || !right) return left === right;
    const l = left as unknown as Record<string, unknown>, r = right as unknown as Record<string, unknown>;
    return equal(left.value, right.value) && Object.keys({ ...l, ...r }).filter(key => key !== 'value').every(key => l[key] === r[key]);
  };
  return Boolean(a && a.version === b.version && a.state === b.state && a.reviewVersion === b.reviewVersion && equal(a.value, b.value)
    && bindingEqual(a.remote, b.remote) && bindingEqual(a.attempt, b.attempt)
    && (a.unboundBase === undefined || b.unboundBase === undefined ? a.unboundBase === b.unboundBase : equal(a.unboundBase, b.unboundBase)));
}

/** Rebase a newer local draft using the same observed-remove rule as COLP; inputs are validated IDB arrays. */
export function rebaseMetadataTags(base: readonly string[], incoming: readonly string[], current: readonly string[]): string[] {
  const observed = new Set(base), wanted = new Set(incoming);
  const deleted = new Set(base.filter(tag => !wanted.has(tag)));
  const merged = new Set(current.filter(tag => !deleted.has(tag)));
  for (const tag of incoming) if (!observed.has(tag)) merged.add(tag);
  return [...merged].sort();
}
