function isStringTagList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(tag => typeof tag === 'string');
}

/**
 * Tags canonical update keeps when `fields.tags` is omitted.
 * They live on `nodes.tags`. Null is the stored empty list.
 * A value that is not a string array is not an empty snapshot.
 */
export function storedNodeTags(tags: unknown): readonly string[] | undefined {
  if (tags == null) return [];
  return isStringTagList(tags) ? tags : undefined;
}

/**
 * Union of the current `nodes.tags` column and this effect's additions, plus the Undo snapshot.
 * `payload_json` may be null or omit a string `tags` array; that projection is not the column.
 */
export function planAutomationTagUpdate(node: {
  tags: unknown;
  payload_json?: Record<string, unknown> | null;
}, additions: readonly string[]): {
  tags: string[];
  previousTags: string[];
} | undefined {
  const stored = storedNodeTags(node.tags);
  if (!stored) return undefined;
  const previousTags = [...stored];
  return { previousTags, tags: [...new Set([...previousTags, ...additions])] };
}
