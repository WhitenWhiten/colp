import {
  isHiddenByCatalogPreferences,
  type CatalogPreferencesView,
} from '../../modules/governance/index.js';
import {
  EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
  type ExploreCatalogPreference,
  type ExplorePageReadPort,
  type ExplorePageReadRequest,
  type ExplorePageRecord,
  type ExplorePageSort,
} from '../../modules/publication/index.js';

export interface ExplorePreferenceSelection {
  readonly records: readonly ExplorePageRecord[];
  /** Sort position the next request must continue after. Null means the catalog ended. */
  readonly resume: ExplorePageRecord | null;
  /**
   * True when resume is set because the scan budget ended before the page
   * filled. The catalog may still contain matches; nextCursor must not be null.
   */
  readonly budgetExhausted: boolean;
}

export function catalogPreferenceActive(prefs: CatalogPreferencesView | null): prefs is CatalogPreferencesView {
  return prefs !== null && (
    prefs.hiddenOwnerAccountIds.length > 0
    || prefs.hiddenTags.length > 0
    || prefs.hiddenTitleKeywords.length > 0
    || prefs.preferredLanguages.length > 0
  );
}

export function toExploreCatalogPreference(prefs: CatalogPreferencesView): ExploreCatalogPreference {
  return {
    hiddenOwnerAccountIds: prefs.hiddenOwnerAccountIds,
    hiddenTags: prefs.hiddenTags,
    hiddenTitleKeywords: prefs.hiddenTitleKeywords,
    preferredLanguages: prefs.preferredLanguages,
  };
}

/**
 * One preference request reads a single keyset window. Hidden rows stay in
 * the window so a short or empty page can resume after the last scanned row.
 * A full page resumes at the last returned match so later matches are not skipped.
 */
export function selectExplorePreferencePage(input: {
  readonly window: readonly ExplorePageRecord[];
  readonly limit: number;
  readonly budget: number;
  readonly prefs: CatalogPreferencesView;
}): ExplorePreferenceSelection {
  const probe = input.window.length > input.budget;
  const scanned = probe ? input.window.slice(0, input.budget) : input.window;
  const visible = scanned.filter((record) => !isExploreRecordHidden(record, input.prefs));
  if (visible.length > input.limit) {
    const records = visible.slice(0, input.limit);
    return {
      records,
      resume: records[records.length - 1] ?? null,
      budgetExhausted: false,
    };
  }
  if (probe) {
    return {
      records: visible,
      resume: scanned[scanned.length - 1] ?? null,
      budgetExhausted: true,
    };
  }
  return { records: visible, resume: null, budgetExhausted: false };
}

export async function loadEligibleExplorePage(
  page: ExplorePageReadPort,
  input: {
    readonly filter: ExplorePageReadRequest['filter'];
    readonly sort: ExplorePageSort;
    readonly limit: number;
    readonly after?: ExplorePageReadRequest['after'];
    readonly prefs: CatalogPreferencesView | null;
  },
): Promise<ExplorePreferenceSelection> {
  if (!catalogPreferenceActive(input.prefs)) {
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
  const window = [...await page.loadPage({
    filter: input.filter,
    sort: input.sort,
    limit: input.limit,
    scanBudget: EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
    catalogPreference: toExploreCatalogPreference(input.prefs),
    ...(input.after ? { after: input.after } : {}),
  })];
  return selectExplorePreferencePage({
    window,
    limit: input.limit,
    budget: EXPLORE_PREFERENCE_SCAN_ROW_BUDGET,
    prefs: input.prefs,
  });
}

function isExploreRecordHidden(record: ExplorePageRecord, prefs: CatalogPreferencesView): boolean {
  if (typeof record.preferenceHidden === 'boolean') return record.preferenceHidden;
  return isHiddenByCatalogPreferences({
    ownerAccountId: record.ownerAccountId ?? '',
    tags: record.tags,
    title: record.title,
    language: record.language ?? null,
  }, prefs);
}
