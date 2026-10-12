import type { CaptureTask } from '../capture/contracts.js';
import { listBrowserCaptureHistory } from '../capture/local-history.js';
import { browserHistoryStore } from '../capture/browser-history-store.js';
import { createBackupHistoryStore } from '../local-backup/history-store.js';
import { aggregateCaptures, captureFact, captureHistoryStatus, type HistoryStatus } from '../capture/history.js';
import { captureStore } from './capture.js';
import { currentCaptureScope, assertCaptureOwner } from './capture-native.js';
import { createClassificationProductClient } from '../classification-product-client.js';
import { captureDateFormatter } from '../capture/statistics.js';
let device: Promise<string> | undefined;
export const backupHistoryStore = createBackupHistoryStore();
export function captureDeviceId(): Promise<string> {
  device ??= (async () => {
    const key = 'known.capture.device.v1', value = (await chrome.storage.local.get(key))[key];
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value)) return value;
    const id = crypto.randomUUID(); await chrome.storage.local.set({ [key]: id }); return id;
  })().catch(error => { device = undefined; throw error; });
  return device;
}
export interface CaptureHistoryRequest {
  readonly kind: 'known.capture.history'; readonly days: 7 | 30 | 90; readonly timezone: string;
  readonly status: HistoryStatus; readonly q: string; readonly source: string; readonly collectionId: string;
  readonly before?: readonly [number, string];
  readonly deviceScope?: 'local' | 'cloud';
  readonly day?: string;
}
export function validCaptureHistory(value: unknown): value is CaptureHistoryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === 'known.capture.history' && [7, 30, 90].includes(Number(raw.days)) && typeof raw.days === 'number'
    && ['all', 'attention', 'progress', 'completed'].includes(String(raw.status))
    && [raw.q, raw.source, raw.collectionId, raw.timezone].every(value => typeof value === 'string' && value.length <= 128)
    && (raw.deviceScope === undefined || raw.deviceScope === 'local' || raw.deviceScope === 'cloud')
    && (raw.day === undefined || typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(raw.day))
    && (raw.before === undefined || (Array.isArray(raw.before) && raw.before.length === 2 && Number.isSafeInteger(raw.before[0]) && typeof raw.before[1] === 'string'))
    && Object.keys(raw).every(key => ['kind', 'days', 'timezone', 'status', 'q', 'source', 'collectionId', 'before', 'deviceScope', 'day'].includes(key));
}
export async function handleCaptureHistory(request: CaptureHistoryRequest) {
  const scope = await currentCaptureScope(), now = Date.now(), from = now - request.days * 86400000;
  new Intl.DateTimeFormat('en', { timeZone: request.timezone });
  if (request.deviceScope === 'cloud') {
    if (!scope.accountId) throw new Error('sign_in_required');
    const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId,
      assertCurrent: () => assertCaptureOwner(scope) });
    const query = { from: new Date(from).toISOString(), to: new Date(now).toISOString(), timezone: request.timezone,
      ...(request.q ? { q: request.q } : {}), ...(request.source ? { source: request.source } : {}),
      ...(request.collectionId ? { collectionId: request.collectionId } : {}) };
    if (request.day) Object.assign(query, { day: request.day });
    const [history, statistics] = await Promise.all([
      client.captureHistory({ ...query, ...(request.before ? { beforeAt: new Date(request.before[0]).toISOString(), beforeId: request.before[1] } : {}) }),
      client.captureHistory(query, true),
    ]);
    if (!('items' in history) || !('counts' in statistics)) throw new Error('capture_history_invalid');
    await assertCaptureOwner(scope);
    return { ok: true, items: [], remoteItems: history.items, statistics,
      next: history.next ? [Date.parse(history.next[0]!), history.next[1]] : null, unreported: 0, deviceId: await captureDeviceId() };
  }
  const dateKey = captureDateFormatter(request.timezone);
  const tasks: CaptureTask[] = []; let before: readonly [number, string] | undefined;
  for (;;) {
    const page = await listBrowserCaptureHistory(captureStore, scope, before, backupHistoryStore, browserHistoryStore);
    tasks.push(...page.filter(task => task.createdAt >= from && (!request.day || dateKey(task.createdAt) === request.day) && (!request.source || task.source === request.source)
      && (!request.collectionId || task.scope.collectionId === request.collectionId)
      && `${task.title} ${task.url}`.toLocaleLowerCase().includes(request.q.toLocaleLowerCase())));
    const last = page.at(-1); if (!last || page.length < 50 || last.createdAt < from) break;
    before = [last.createdAt, last.captureId];
  }
  await assertCaptureOwner(scope);
  const matching = tasks.filter(task => (request.status === 'all' || captureHistoryStatus(task) === request.status)
    && (!request.before || task.createdAt < request.before[0] || (task.createdAt === request.before[0] && task.captureId < request.before[1])));
  const items = matching.slice(0, 50), last = items.at(-1);
  return { ok: true, items, next: matching.length > 50 && last ? [last.createdAt, last.captureId] : null,
    statistics: aggregateCaptures(tasks.map(captureFact), { from, to: now + 1, timezone: request.timezone, now }),
    unreported: tasks.filter(task => !('historyReadOnly' in task) && task.scope.accountId && task.sync !== 'local-only' && (task.reportedRevision ?? -1) < task.revision).length,
    deviceId: await captureDeviceId() };
}
export async function captureCloudAvailable() {
  const scope = await currentCaptureScope(); if (!scope.accountId || navigator.onLine === false) return { ok: true, available: false };
  const client = createClassificationProductClient({ serverOrigin: scope.serverOrigin, expectedAuthUserId: scope.accountId, assertCurrent: () => assertCaptureOwner(scope) });
  try { const result = await client.captureHistory({}, true); return { ok: true, available: 'counts' in result }; }
  catch { return { ok: true, available: false }; }
}
