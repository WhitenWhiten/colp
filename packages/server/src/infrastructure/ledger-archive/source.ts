export interface LedgerArchiveSourceBounds {
  readonly lowerInclusive: bigint;
  readonly upperExclusive: bigint;
}

export interface LedgerArchiveSourcePage<Row> {
  readonly rows: readonly Row[];
  /** True only when another keyset page exists within the closed segment bounds. */
  readonly hasMore: boolean;
}

export interface LedgerArchiveSource<Row> {
  readonly ledgerFamily: string;
  readonly sourceRelation: string;
  readonly sourceScope: string;
  readonly keyOf: (row: Row) => bigint;
  readonly archiveValue: (row: Row) => unknown;
  readonly readPage: (input: Readonly<{
    bounds: LedgerArchiveSourceBounds;
    afterExclusive?: bigint;
    limit: number;
    signal?: AbortSignal;
  }>) => Promise<LedgerArchiveSourcePage<Row>>;
}

export class LedgerArchiveSourceRegistry {
  private readonly sources = new Map<string, LedgerArchiveSource<unknown>>();

  register<Row>(source: LedgerArchiveSource<Row>): void {
    if (this.sources.has(source.ledgerFamily)) throw new Error('ledger_archive_source_already_registered');
    this.sources.set(source.ledgerFamily, source as LedgerArchiveSource<unknown>);
  }

  require<Row = unknown>(ledgerFamily: string): LedgerArchiveSource<Row> {
    const source = this.sources.get(ledgerFamily);
    if (!source) throw new Error(`ledger_archive_source_not_registered:${ledgerFamily}`);
    return source as LedgerArchiveSource<Row>;
  }
}

export async function* readLedgerArchiveSourceRows<Row>(
  source: LedgerArchiveSource<Row>,
  bounds: LedgerArchiveSourceBounds,
  options: Readonly<{ pageSize: number; signal?: AbortSignal }>,
): AsyncGenerator<Readonly<{ key: bigint; value: unknown }>> {
  if (bounds.lowerInclusive >= bounds.upperExclusive) throw new RangeError('archive_source_bounds_invalid');
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 10_000) {
    throw new RangeError('archive_source_page_size_invalid');
  }
  let afterExclusive: bigint | undefined;
  for (;;) {
    if (options.signal?.aborted) throw abortError();
    const page = await source.readPage({
      bounds,
      ...(afterExclusive === undefined ? {} : { afterExclusive }),
      limit: options.pageSize,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (page.rows.length > options.pageSize || (page.rows.length === 0 && page.hasMore)) {
      throw new Error('archive_source_page_contract_violated');
    }
    for (const row of page.rows) {
      const key = source.keyOf(row);
      if (key < bounds.lowerInclusive || key >= bounds.upperExclusive
          || (afterExclusive !== undefined && key <= afterExclusive)) {
        throw new Error('archive_source_key_order_violated');
      }
      afterExclusive = key;
      yield Object.freeze({ key, value: source.archiveValue(row) });
    }
    if (!page.hasMore) return;
  }
}

function abortError(): Error {
  return Object.assign(new Error('ledger archive source read aborted'), { name: 'AbortError' });
}
