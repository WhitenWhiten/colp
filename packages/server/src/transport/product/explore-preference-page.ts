import type {
  ExplorePageReadPort,
  ExplorePageReadRequest,
  ExplorePageRecord,
  ExplorePageSort,
} from '../../modules/publication/index.js';

export interface ExplorePreferenceSelection {
  readonly records: readonly ExplorePageRecord[];
  readonly resume: ExplorePageRecord | null;
  readonly budgetExhausted: boolean;
}

export async function loadEligibleExplorePage(
  page: ExplorePageReadPort,
  input: {
    readonly filter: ExplorePageReadRequest['filter'];
    readonly sort: ExplorePageSort;
    readonly limit: number;
    readonly after?: ExplorePageReadRequest['after'];
  },
): Promise<ExplorePreferenceSelection> {
  const rows = [...await page.loadPage({
    filter: input.filter,
    sort: input.sort,
    limit: input.limit,
    ...(input.after ? { after: input.after } : {}),
  })];
  const records = rows.slice(0, input.limit);
  return {
    records,
    resume: rows.length > input.limit ? records[records.length - 1] ?? null : null,
    budgetExhausted: false,
  };
}
