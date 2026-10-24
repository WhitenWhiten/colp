import type { CaptureScope, CaptureSource, CaptureTask } from './contracts.js';

/** Device activity only. No account, collection, remote commands, tags or notes. */
export interface BrowserHistoryFact {
  readonly version: 1;
  readonly captureId: string;
  readonly nativeId: string;
  readonly parentNativeId: string;
  readonly title: string;
  readonly url: string;
  readonly source: CaptureSource;
  readonly automatic: boolean;
  readonly createdAt: number;
  readonly savedAt: number;
}
const SOURCES = new Set<CaptureSource>(['action-popup', 'manual-popup', 'context-page', 'context-link', 'batch', 'site-favorite', 'site-import', 'site-reconcile']);

export function browserHistoryFact(task: Pick<CaptureTask,
  'captureId' | 'targetNativeId' | 'title' | 'url' | 'source' | 'automaticIntent' | 'createdAt'>,
  nativeId: string, savedAt: number): BrowserHistoryFact {
  const fact: BrowserHistoryFact = { version: 1, captureId: task.captureId, nativeId,
    parentNativeId: task.targetNativeId, title: task.title, url: task.url, source: task.source,
    automatic: task.automaticIntent, createdAt: task.createdAt, savedAt };
  if (!isBrowserHistoryFact(fact)) throw new Error('browser_history_invalid');
  return fact;
}

export function isBrowserHistoryFact(value: unknown): value is BrowserHistoryFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['version', 'captureId', 'nativeId', 'parentNativeId', 'title', 'url', 'source', 'automatic', 'createdAt', 'savedAt'];
  return Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key))
    && row.version === 1 && ['captureId', 'nativeId', 'parentNativeId'].every(key =>
      typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 2048)
    && typeof row.title === 'string' && row.title.length <= 65536
    && typeof row.url === 'string' && row.url.length > 0 && row.url.length <= 131072
    && typeof row.source === 'string' && SOURCES.has(row.source as CaptureSource)
    && typeof row.automatic === 'boolean'
    && Number.isSafeInteger(row.createdAt) && Number(row.createdAt) >= 0
    && Number.isSafeInteger(row.savedAt) && Number(row.savedAt) >= 0;
}

/** Read-only projection for existing history rendering. Never a replayable capture. */
export function browserHistoryItem(fact: BrowserHistoryFact, scope: CaptureScope): CaptureTask & {
  readonly historyReadOnly: true; readonly historyOrigin: 'device';
} {
  if (!isBrowserHistoryFact(fact)) throw new Error('browser_history_invalid');
  return {
    version: 1, captureId: fact.captureId, commandId: fact.captureId, batchId: null,
    scope: { serverOrigin: scope.serverOrigin, accountId: null, collectionId: null, authorityGeneration: 0 },
    source: fact.source, tabId: null, url: fact.url, title: fact.title, targetNativeId: fact.parentNativeId,
    insertPosition: 'bottom', saveAnother: false, allowUnverifiedCloud: false,
    createdAt: fact.createdAt, savedAt: fact.savedAt, updatedAt: fact.savedAt, revision: 1,
    // A device fact is not an account-owned AI task. Do not fabricate AI
    // eligibility, failed suggestions or pending cloud work from missing receipts.
    policyVersion: 'device-history-v1', automaticIntent: false, disposition: 'new',
    save: 'local-saved', classification: 'none', sync: 'local-only', existence: null,
    nativeIntentId: null, nativeId: fact.nativeId, nodeId: null, executionId: null, decisionId: null,
    localLocation: { nativeId: fact.nativeId, nodeId: null, collectionId: null,
      collectionTitle: null, path: [], writable: false, url: fact.url },
    cloudLocation: null, appliedRevision: null, manualFence: 0, controlGeneration: 0, reason: null,
    historyReadOnly: true, historyOrigin: 'device',
  };
}
