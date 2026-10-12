import type { AttentionReportRecord, AttentionItemRecord } from '../bootstrap/attention-report.js';
import { requestValue } from './idb.js';
import { validateRecord } from './codec.js';
import { STORES } from './schema.js';

const PAGE_SIZE = 100;
const pageId = (key: string, reportId: string, page: number) => `attention:${key}:${reportId}:${page}`;

export async function storeAttentionPages(tx: IDBTransaction, key: string, report: AttentionReportRecord, maxBytes: number) {
  const store = tx.objectStore(STORES.diagnostics);
  const pageCount = Math.ceil(report.items.length / PAGE_SIZE);
  for (let page = 0; page < pageCount; page++) {
    const row = { id: pageId(key, report.reportId, page), scopeKey: key, kind: 'attention_page',
      items: report.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
    validateRecord(row, maxBytes); store.put(row);
  }
  return { ...report, items: [], pageCount };
}

export async function loadAttentionPages(tx: IDBTransaction, key: string, report: AttentionReportRecord): Promise<AttentionReportRecord> {
  if (report.pageCount === undefined) return report;
  const pages = await Promise.all(Array.from({ length: report.pageCount }, (_, page) =>
    requestValue(tx.objectStore(STORES.diagnostics).get(pageId(key, report.reportId, page))) as
      Promise<{ items: AttentionItemRecord[] } | undefined>));
  if (pages.some(page => !page)) throw new Error('attention_page_missing');
  return { ...report, items: pages.flatMap(page => page!.items) };
}
