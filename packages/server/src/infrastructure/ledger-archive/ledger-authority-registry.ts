import { createHash } from 'node:crypto';

import { LEDGER_CAPACITY_TARGETS } from '../database/ledger-capacity.js';
import { LEDGER_RETENTION_POLICIES } from '../database/ledger-retention-policy.js';
import {
  AUDIT_PAYLOAD_ARCHIVE_FAMILY,
  AUDIT_PAYLOAD_ARCHIVE_RELATION,
  OPERATION_ARCHIVE_FAMILY,
  OPERATION_ARCHIVE_RELATION,
} from './production-sources.js';
import {
  SOCIAL_OUTBOX_ARCHIVE_FAMILY,
  SOCIAL_OUTBOX_ARCHIVE_RELATION,
} from './social-outbox-source.js';

export const LEDGER_ARCHIVE_SOURCE_RELATIONS = Object.freeze([
  Object.freeze({
    family: OPERATION_ARCHIVE_FAMILY,
    sourceRelation: OPERATION_ARCHIVE_RELATION,
    tableName: 'operation_payloads',
  }),
  Object.freeze({
    family: AUDIT_PAYLOAD_ARCHIVE_FAMILY,
    sourceRelation: AUDIT_PAYLOAD_ARCHIVE_RELATION,
    tableName: 'audit_event_payloads',
  }),
  Object.freeze({
    family: SOCIAL_OUTBOX_ARCHIVE_FAMILY,
    sourceRelation: SOCIAL_OUTBOX_ARCHIVE_RELATION,
    tableName: 'outbox_events',
  }),
]);

export const ORDINARY_PULL_CONTRACT = Object.freeze({
  path: 'hot_history_only',
  cursorBehindFloor: 'recovery_required',
  missingHotAfterFloor: 'integrity_failure',
  archiveFallback: false,
});

export function createLedgerAuthorityRegistry() {
  return Object.freeze({
    archiveSources: LEDGER_ARCHIVE_SOURCE_RELATIONS,
    capacity: LEDGER_CAPACITY_TARGETS.map((target) => Object.freeze({
      tableName: target.tableName,
      family: target.family,
      retentionClass: target.retentionClass,
      archiveBlocker: target.archiveBlocker,
      owner: target.owner,
      growthDriver: target.growthDriver,
      cleanupMechanism: target.cleanupMechanism,
      requiredIndex: target.requiredIndex,
      warnRows: target.warnRows.toString(),
      warnBytes: target.warnBytes.toString(),
      warnDeadRatio: target.warnDeadRatio,
      recoveryDependency: target.recoveryDependency,
      replacesTableName: target.replacesTableName,
    })),
    retention: LEDGER_RETENTION_POLICIES.map((policy) => Object.freeze({
      tableName: policy.tableName,
      family: policy.family,
      policyStatus: policy.policyStatus,
      sourceDeletionAuthorized: policy.sourceDeletionAuthorized,
      onlineColdRead: policy.onlineColdRead,
      hotRetention: policy.hotRetention,
    })),
    ordinaryPull: ORDINARY_PULL_CONTRACT,
  });
}

export type LedgerAuthorityRegistry = ReturnType<typeof createLedgerAuthorityRegistry>;

export function serializeLedgerAuthorityRegistry(
  registry: LedgerAuthorityRegistry = createLedgerAuthorityRegistry(),
): string {
  return `${stableStringify(registry)}\n`;
}

export function ledgerAuthorityRegistryDigest(
  registry: LedgerAuthorityRegistry = createLedgerAuthorityRegistry(),
): string {
  return createHash('sha256').update(serializeLedgerAuthorityRegistry(registry)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
