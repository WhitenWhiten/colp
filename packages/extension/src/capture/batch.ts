import type { CaptureExistence, CaptureScope } from './contracts.js';
import { supportedCaptureUrl } from './existence.js';
import { t } from '../i18n.js';

export interface CaptureBatchItem {
  readonly itemId: string;
  readonly commandId: string;
  readonly tabIds: readonly number[];
  readonly title: string;
  readonly url: string | null;
  readonly reason: 'unreadable' | 'unsupported' | null;
  readonly existence: CaptureExistence | null;
  readonly captureId: string | null;
  readonly error?: string;
}
export interface CaptureBatch {
  readonly batchId: string;
  readonly scope: CaptureScope;
  readonly windowId: number | null;
  readonly selection: 'all' | 'selected';
  readonly tabsPermission: boolean;
  readonly createdAt: number;
  readonly confirmed: boolean;
  readonly selectedIds: readonly string[];
  readonly saveAnotherIds: readonly string[];
  readonly targetNativeId: string | null;
  /** `explicit`: the user changed the folder on the page, so no rule moves these saves. Older batches are explicit. */
  readonly folderChoice?: 'explicit' | 'default';
  readonly items: readonly CaptureBatchItem[];
}
export function freezeCaptureTabs(tabs: readonly chrome.tabs.Tab[], uuid: () => string): CaptureBatchItem[] {
  const items: CaptureBatchItem[] = [];
  const urls = new Map<string, number>();
  for (const tab of tabs) {
    const url = typeof tab.url === 'string' ? tab.url : null;
    const prior = url ? urls.get(url) : undefined;
    if (prior !== undefined) {
      const item = items[prior]!;
      items[prior] = { ...item, tabIds: [...item.tabIds, ...(tab.id === undefined ? [] : [tab.id])] };
      continue;
    }
    if (url) urls.set(url, items.length);
    items.push({ itemId: uuid(), commandId: uuid(), tabIds: tab.id === undefined ? [] : [tab.id],
      title: tab.title || (url ?? t('common_unreadableTab', 'Unreadable tab')), url,
      reason: !url ? 'unreadable' : supportedCaptureUrl(url) ? null : 'unsupported', existence: null, captureId: null });
  }
  return items;
}

export type CaptureBatchRequest =
  | { readonly kind: 'known.capture.batch.preview'; readonly selection: 'all' | 'selected'; readonly windowId?: number }
  | { readonly kind: 'known.capture.batch.get' | 'known.capture.batch.resume'; readonly batchId: string }
  | { readonly kind: 'known.capture.batch.confirm'; readonly batchId: string; readonly selectedIds: readonly string[];
      readonly saveAnotherIds: readonly string[]; readonly targetNativeId: string; readonly allowUnverifiedCloud: boolean; readonly userGesture: true;
      readonly folderChoice?: 'explicit' | 'default' };
export function validCaptureBatchRequest(value: unknown): value is CaptureBatchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id);
  if (raw.kind === 'known.capture.batch.preview') return ['all', 'selected'].includes(String(raw.selection))
    && (raw.windowId === undefined || Number.isSafeInteger(raw.windowId))
    && Object.keys(raw).every(key => ['kind', 'selection', 'windowId'].includes(key));
  if (!uuid(raw.batchId)) return false;
  if (raw.kind === 'known.capture.batch.get' || raw.kind === 'known.capture.batch.resume') return Object.keys(raw).length === 2;
  return raw.kind === 'known.capture.batch.confirm' && raw.userGesture === true
    && typeof raw.targetNativeId === 'string' && /^[\w.-]{1,128}$/u.test(raw.targetNativeId)
    && typeof raw.allowUnverifiedCloud === 'boolean'
    && Array.isArray(raw.selectedIds) && raw.selectedIds.length <= 1000 && raw.selectedIds.every(uuid)
    && Array.isArray(raw.saveAnotherIds) && raw.saveAnotherIds.length <= 1000 && raw.saveAnotherIds.every(uuid)
    && (raw.folderChoice === undefined || raw.folderChoice === 'explicit' || raw.folderChoice === 'default')
    && Object.keys(raw).length === (raw.folderChoice === undefined ? 7 : 8);
}
