import { createHash } from 'node:crypto';
import { deepEqualSyncMergeValue } from '@know-n/colp/sync';
import type { Selectable } from 'kysely';
import { mergeSyncNodeContentFields, SyncConflictResolutionError,
  type ProductConflictResolutionBlockedReason } from '../../modules/sync/index.js';
import type { SyncConflictTable } from '../database/runtime.js';
import { executableSyncConflictResolutions } from './sync-conflict-postgres.js';
import type { PrivateConflictPayload } from './sync-conflict-private-payload.js';
import { stableJson } from './sync-conflict-json.js';

type Admission = Pick<Selectable<SyncConflictTable>, 'conflict_id' | 'revision' | 'current_revision'
  | 'conflict_type' | 'conflicting_fields' | 'allowed_resolutions'>;
export interface CurrentConflictNode {
  readonly kind: PrivateConflictPayload['nodeKind'];
  readonly resourceRevision: string;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly resolutionWriteBlockedReason: ProductConflictResolutionBlockedReason | null;
}

function valueAt(payload: Readonly<Record<string, unknown>>, field: string): unknown {
  if (field === 'extensions') return payload[field] ?? {};
  if (field === 'urlHash' || field === 'canonicalUrl') return payload[field] ?? null;
  return payload[field];
}
const contentField = (field: string) => field !== 'baseRevision' && field !== 'deletedAt';

/** A current decision view, never a rewrite of encrypted admission or wire
 * history. GET plans from one joined snapshot; resolve plans again under the
 * canonical node lock before accepting the same revision. */
export function planSyncConflictDecision(admission: Admission, retained: PrivateConflictPayload,
  current: CurrentConflictNode) {
  const fields = new Set(admission.conflicting_fields);
  const retainedFields = Object.keys(retained.incoming).filter(contentField);
  const relevantFields = new Set([...retainedFields, ...admission.conflicting_fields
    .map(pointer => pointer.slice(1)).filter(contentField)]);
  if (current.deleted) fields.add('/deletedAt');
  if (current.payload && !current.deleted) {
    for (const field of retainedFields) {
      const merged = mergeSyncNodeContentFields({ [field]: valueAt(retained.base, field) },
        { [field]: valueAt(current.payload, field) }, { [field]: valueAt(retained.incoming, field) });
      if (merged.status === 'conflict') fields.add(`/${field}`);
    }
  }
  const type = current.deleted ? 'delete_update' as const : admission.conflict_type;
  const supported = executableSyncConflictResolutions({ ...admission, conflict_type: type },
    current.kind, current.payload !== null && retainedFields.length > 0);
  const writeBlockedReason = current.resolutionWriteBlockedReason
    ?? (current.payload === null ? 'resource_not_found' : null);
  // Live server choices still merge independent incoming fields and emit a
  // canonical write. Only accepting an existing tombstone is a true no-op.
  const allowedResolutions = Object.freeze(supported.filter(resolution => writeBlockedReason === null
    || (current.deleted && resolution === 'server')));
  const resolutionBlockedReason = allowedResolutions.length === 0 ? writeBlockedReason : null;
  const changed = writeBlockedReason !== null
    || current.deleted !== (admission.conflict_type === 'delete_update') || current.payload === null
    || [...relevantFields].some(field => !deepEqualSyncMergeValue(
      valueAt(current.payload!, field), valueAt(retained.current, field)));
  const conflictingFields = Object.freeze([...fields].sort());
  // A move or an edit outside the retained decision domain leaves its tag
  // unchanged. Once a relevant value changes, the canonical revision also
  // fences another concurrent write between refresh and confirmation.
  const revision = changed ? `conflict-decision-${createHash('sha256').update(stableJson({
    conflictId: admission.conflict_id, admissionRevision: admission.revision,
    nodeRevision: current.resourceRevision, type, fields: conflictingFields,
    allowedResolutions, writeBlockedReason,
  }, () => { throw new SyncConflictResolutionError('invalid_document'); })).digest('hex').slice(0, 40)}` : admission.revision;
  return Object.freeze({ revision, type, conflictingFields, allowedResolutions,
    ...(resolutionBlockedReason === null ? {} : { resolutionBlockedReason }),
    summary: Object.freeze({ current: summarizeConflictContent(current.payload, conflictingFields),
      incoming: summarizeConflictContent(retained.incoming, conflictingFields) }) });
}

/** Safe, bounded previews only; URLs and extension bodies never become copy. */
export function summarizeConflictContent(payload: Readonly<Record<string, unknown>> | null,
  fields: readonly string[]): string | null {
  if (!payload) return null;
  const labels: Readonly<Record<string, string>> = { title: 'Title', description: 'Description', visibility: 'Visibility' };
  const safe = fields.map(pointer => pointer.slice(1)).filter(field => Object.hasOwn(labels, field));
  if (safe.length === 0) return null;
  const text = safe.length === 1 ? payload[safe[0]!]
    : safe.map(field => `${labels[field]}: ${typeof payload[field] === 'string' ? payload[field] : '(empty)'}`).join('\n');
  if (typeof text !== 'string') return null;
  if (text.length <= 256) return text;
  let prefix = text.slice(0, 255);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}
