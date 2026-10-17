import { sql } from 'kysely';

/** Alias i is a favicon_job_items row. Empty sources are restore-only work. */
export function faviconItemCachedSql() {
  return sql<boolean>`(i.source_url = '' OR
    EXISTS (SELECT 1 FROM favicon_provider_cache c
      WHERE c.source_key=encode(public.digest(convert_to(i.source_url,'UTF8'),'sha256'),'hex')
        AND c.body IS NOT NULL AND c.expires_at > clock_timestamp())
    OR EXISTS (SELECT 1 FROM favicon_shared_domains d
      WHERE d.hostname=regexp_replace(substring(i.source_url from '[^/]+$'), '^www[.]', '')
        AND d.object_id IS NOT NULL))`;
}

/** Cached bytes never need provider admission; item-specific retry backoff still applies. */
export function faviconItemReadyAtSql() {
  return sql<Date | null>`greatest(i.next_attempt_at, CASE WHEN ${faviconItemCachedSql()}
    THEN NULL ELSE (SELECT greatest(p.next_request_at,p.lease_until)
      FROM favicon_provider_admission p WHERE p.provider=substring(i.source_url from '^https://[^/]+')) END)`;
}
