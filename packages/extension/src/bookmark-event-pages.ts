export const BOOKMARK_EVENT_PAGE_SIZE = 100;
/** Safety valve only. Stop on a short page; do not abandon authored move history after 64 pages. */
export const BOOKMARK_EVENT_MAX_PAGES = 10_000;

export async function findProcessedBookmarkEvent<T extends {
  readonly ordinal: number; readonly opId: string | null; readonly kind: string;
}>(
  readPage: (afterOrdinal: number, limit: number) => Promise<readonly T[]>,
  opId: string,
  kind: 'create' | 'move' | 'remove',
  pageSize = BOOKMARK_EVENT_PAGE_SIZE,
  maxPages = BOOKMARK_EVENT_MAX_PAGES,
): Promise<T | null> {
  let afterOrdinal = 0;
  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const page = await readPage(afterOrdinal, pageSize);
    const match = page.find((event) => event.opId === opId && event.kind === kind);
    if (match) return match;
    if (page.length < pageSize) return null;
    afterOrdinal = page[page.length - 1]!.ordinal;
  }
  return null;
}

export function findProcessedMoveEvent<T extends {
  readonly ordinal: number; readonly opId: string | null; readonly kind: string;
}>(
  readPage: (afterOrdinal: number, limit: number) => Promise<readonly T[]>,
  opId: string,
  pageSize = BOOKMARK_EVENT_PAGE_SIZE,
  maxPages = BOOKMARK_EVENT_MAX_PAGES,
): Promise<T | null> {
  return findProcessedBookmarkEvent(readPage, opId, 'move', pageSize, maxPages);
}
