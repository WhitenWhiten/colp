/** The wire limits and lossless local retention are distinct: a merge can temporarily exceed the wire budget. */
export const BOOKMARK_TAG_LIMITS = { count: 64, length: 64 } as const;
export const RETAINED_TAG_LIMITS = { count: 128, length: 128 } as const;

export function tagsFitSync(tags: readonly string[]): boolean {
  return tags.length <= BOOKMARK_TAG_LIMITS.count && new Set(tags).size === tags.length
    && tags.every(tag => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= BOOKMARK_TAG_LIMITS.length);
}
export function validateRetainedTags(tags: readonly string[]): void {
  if (tags.length > RETAINED_TAG_LIMITS.count || new Set(tags).size !== tags.length
    || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > RETAINED_TAG_LIMITS.length)) {
    throw new Error('bookmark_annotation_invalid');
  }
}
