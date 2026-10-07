import type { BookmarkResource } from '../../../types/catalog'

/** Read a catalog meta field as a string; absent keys stay undefined. */
export function metaString(resource: BookmarkResource, key: string): string | undefined {
  const value = resource.meta?.[key]
  return value == null ? undefined : String(value)
}
