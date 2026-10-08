import type { ExploreCatalogPreference } from '../../modules/publication/index.js';

/**
 * SQL twin of isHiddenByCatalogPreferences for one already-bounded keyset row.
 * Keywords are stored NFC-trimmed and lowercased. Title comparison is NFC
 * then ICU root lower(), which matches String#toLowerCase (including İ and
 * final sigma) rather than the database locale. Tags and languages stay exact.
 * Returns a boolean expression: true when the row is hidden.
 */
export function explorePreferenceHiddenSql(
  columns: {
    readonly accountId: string;
    readonly title: string;
    readonly tags: string;
    readonly language: string;
  },
  preference: ExploreCatalogPreference,
  parameter: (value: unknown) => string,
): string {
  const keep: string[] = [];
  if (preference.hiddenOwnerAccountIds.length > 0) {
    const owners = parameter([...preference.hiddenOwnerAccountIds]);
    keep.push(`${columns.accountId} <> all (${owners}::text[])`);
  }
  if (preference.hiddenTags.length > 0) {
    const tags = parameter([...preference.hiddenTags]);
    keep.push(`not (coalesce(${columns.tags}, '[]'::jsonb) ?| ${tags}::text[])`);
  }
  if (preference.hiddenTitleKeywords.length > 0) {
    const keywords = parameter([...preference.hiddenTitleKeywords]);
    keep.push(`not exists (
      select 1 from unnest(${keywords}::text[]) as keyword
      where strpos(lower(normalize(coalesce(${columns.title}, '')) collate "und-x-icu"), keyword) > 0
    )`);
  }
  if (preference.preferredLanguages.length > 0) {
    const languages = parameter([...preference.preferredLanguages]);
    keep.push(`(${columns.language} is not null and ${columns.language} = any (${languages}::text[]))`);
  }
  if (keep.length === 0) return 'false';
  return `not (${keep.join(' and ')})`;
}
