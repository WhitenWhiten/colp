import { CaptureError, type CaptureActor, type CaptureDecision } from './capture-contracts.js';
import type { CaptureStatistics, CaptureStatisticFact } from './capture-statistics.js';
export interface CaptureReport {
  readonly captureId: string; readonly deviceId: string; readonly collectionId: string; readonly nodeId: string | null;
  readonly revision: number; readonly startedAt: string; readonly title: string; readonly url: string; readonly localPath: readonly string[];
  readonly source: 'action-popup' | 'manual-popup' | 'context-page' | 'context-link' | 'batch';
  readonly disposition: CaptureStatisticFact['disposition']; readonly save: CaptureStatisticFact['save'];
  readonly savedAt?: string; readonly classificationAppliedAt?: string;
  readonly automaticIntent: boolean; readonly sync: CaptureStatisticFact['sync']; readonly reason: string | null;
}
/**
 * Capture identity is owned exclusively by the `bookmark_capture_tasks`
 * columns. `report_json` stores mutable progress only, so a copy inside the
 * document can never diverge from — or outvote — the row it belongs to.
 */
export const CAPTURE_REPORT_IDENTITY_FIELDS = ['captureId', 'deviceId', 'collectionId', 'revision', 'startedAt'] as const;
export type CaptureReportIdentityField = (typeof CAPTURE_REPORT_IDENTITY_FIELDS)[number];
export type CaptureTaskProgress = Omit<CaptureReport, CaptureReportIdentityField>;
export interface CaptureHistoryItem { readonly report: CaptureReport; readonly decision: CaptureDecision | null; readonly fact: CaptureStatisticFact }
export interface CaptureHistoryQuery { readonly from: number; readonly to: number; readonly timezone: string; readonly deviceId?: string;
  readonly before?: readonly [string, string]; readonly q?: string; readonly captureId?: string; readonly source?: CaptureReport['source']; readonly collectionId?: string; readonly day?: string }
export interface CaptureHistoryRuntime {
  start?(): void;
  stop?(): Promise<void>;
  prune?(): Promise<void>;
  report(actor: CaptureActor, commandId: string, report: CaptureReport): Promise<{ captureId: string; revision: number }>;
  history(actor: CaptureActor, query: CaptureHistoryQuery): Promise<{ items: readonly CaptureHistoryItem[]; next: readonly [string, string] | null; updatedAt: string }>;
  aggregate(actor: CaptureActor, query: CaptureHistoryQuery): Promise<CaptureStatistics>;
}
export function parseCaptureReport(value: unknown): CaptureReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaptureError('invalid_request');
  const raw = value as Record<string, unknown>;
  const fields = ['captureId', 'deviceId', 'collectionId', 'nodeId', 'revision', 'startedAt', 'title', 'url', 'localPath', 'source', 'disposition', 'save', 'automaticIntent', 'sync', 'reason'];
  if (fields.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !fields.includes(key) && !['savedAt', 'classificationAppliedAt'].includes(key))
    || ![raw.captureId, raw.deviceId].every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id))
    || typeof raw.collectionId !== 'string' || !raw.collectionId || raw.collectionId.length > 128
    || (raw.nodeId !== null && (typeof raw.nodeId !== 'string' || !raw.nodeId || raw.nodeId.length > 128))
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt))
    || typeof raw.title !== 'string' || raw.title.length > 4096 || typeof raw.url !== 'string' || raw.url.length > 8192
    || !Array.isArray(raw.localPath) || raw.localPath.length > 128 || raw.localPath.some(part => typeof part !== 'string' || part.length > 4096)
    || !['action-popup', 'manual-popup', 'context-page', 'context-link', 'batch'].includes(String(raw.source))
    || !['new', 'existing', 'cancelled'].includes(String(raw.disposition)) || !['unsubmitted', 'local-saved', 'unknown', 'failed'].includes(String(raw.save))
    || typeof raw.automaticIntent !== 'boolean' || !['local-only', 'pending', 'syncing', 'confirmed', 'attention'].includes(String(raw.sync))
    || (raw.reason !== null && (typeof raw.reason !== 'string' || !/^[a-z0-9_:-]{1,128}$/u.test(raw.reason)))) throw new CaptureError('invalid_request');
  try { const url = new URL(raw.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
  catch { throw new CaptureError('invalid_request'); }
  for (const field of ['savedAt', 'classificationAppliedAt']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !Number.isFinite(Date.parse(raw[field])))) throw new CaptureError('invalid_request');
  }
  return { ...raw, startedAt: new Date(raw.startedAt as string).toISOString(),
    ...(raw.savedAt ? { savedAt: new Date(String(raw.savedAt)).toISOString() } : {}),
    ...(raw.classificationAppliedAt ? { classificationAppliedAt: new Date(String(raw.classificationAppliedAt)).toISOString() } : {}) } as unknown as CaptureReport;
}
