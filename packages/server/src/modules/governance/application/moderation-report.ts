import { assertCanonicalCommandId, type ProductCommandReceiptPort } from '../../commands/index.js';
import { strongEntityTag } from '../../collections/index.js';
import {
  captureEvidence,
  governanceTimestamp,
  targetFingerprint,
  type ReportInput,
} from '../domain/moderation.js';
import {
  toMyCase,
  type ModerationCaseRecord,
  type ModerationCommandPorts,
} from './moderation-ports.js';
import type { MyCase } from '../domain/moderation.js';

export const MODERATION_REPORT_CONTRACT_VERSION = '1.0.0';
export const SUBMIT_MODERATION_REPORT_OPERATION = 'submitModerationReport';

export type SubmitModerationReportResult =
  | { readonly kind: 'created'; readonly status: 201; readonly case: MyCase }
  | { readonly kind: 'deduped'; readonly status: 200; readonly case: MyCase }
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

export async function submitModerationReport(
  ports: ModerationCommandPorts,
  input: {
    readonly actor: { readonly accountId: string; readonly subjectId: string; readonly principalId: string };
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
    readonly report: ReportInput;
  },
): Promise<SubmitModerationReportResult> {
  const commandId = assertCanonicalCommandId(input.commandId);
  const snapshot = await ports.targets.resolve(input.actor, input.report.target);
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
  const fingerprint = targetFingerprint(input.report.target);
  const existing = await ports.store.findOpenCase(
    input.actor.accountId,
    fingerprint,
    input.report.category,
  );
  if (existing) {
    return completeExisting(ports.receipts, binding, input.fingerprint, existing);
  }
  const now = governanceTimestamp(await ports.clock.now());
  const caseId = ports.ids.nextCaseId();
  const evidenceId = ports.ids.nextEvidenceId();
  const evidence = captureEvidence(snapshot, { id: evidenceId, caseId });
  const record: ModerationCaseRecord = {
    id: caseId,
    reporterAccountId: input.actor.accountId,
    target: input.report.target,
    targetFingerprint: fingerprint,
    category: input.report.category,
    description: input.report.description,
    status: 'submitted',
    publicResolution: null,
    assignedToAccountId: null,
    internalNote: null,
    revision: '1',
    createdAt: now,
    updatedAt: now,
    evidenceIds: Object.freeze([evidenceId]),
    actionIds: Object.freeze([]),
  };
  const inserted = await ports.store.insertCase(record);
  if (inserted === 'duplicate_open') {
    const raced = await ports.store.findOpenCase(
      input.actor.accountId,
      fingerprint,
      input.report.category,
    );
    if (!raced) throw new Error('open moderation case disappeared after duplicate');
    return completeExisting(ports.receipts, binding, input.fingerprint, raced);
  }
  await ports.store.insertEvidence(evidence);
  const view = toMyCase(record);
  await completeReceipt(ports.receipts, binding, input.fingerprint, 201, view);
  return { kind: 'created', status: 201, case: view };
}

async function completeExisting(
  receipts: ProductCommandReceiptPort,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  record: ModerationCaseRecord,
): Promise<Extract<SubmitModerationReportResult, { kind: 'deduped' }>> {
  const view = toMyCase(record);
  await completeReceipt(receipts, binding, fingerprint, 200, view);
  return { kind: 'deduped', status: 200, case: view };
}

async function completeReceipt(
  receipts: ProductCommandReceiptPort,
  binding: { readonly principalId: string; readonly commandScope: string; readonly commandId: string },
  fingerprint: string,
  status: 200 | 201,
  view: MyCase,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(view));
  const etag = strongEntityTag(view.revision);
  await receipts.complete(binding, fingerprint, {
    status,
    body,
    stableHeaders: {
      etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: MODERATION_REPORT_CONTRACT_VERSION,
    targetIdentity: view.id,
  });
}
