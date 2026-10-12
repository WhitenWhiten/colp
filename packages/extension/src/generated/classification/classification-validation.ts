// Generated from Know-N's server classification policy. Do not edit: Know-N regenerates this file.
class CollectionsError extends Error {constructor(readonly code:string,message:string){super(message);}}
const TAG_MAX_ITEMS = 64;
const TAG_MAX_LENGTH = 64;
export function assertValidNodeTags(tags: readonly string[]): readonly string[] {
  if (!Array.isArray(tags)) {
    throw new CollectionsError('invalid_node_tags', 'tags must be an array');
  }
  if (tags.length > TAG_MAX_ITEMS) {
    throw new CollectionsError(
      'invalid_node_tags',
      `tags must have at most ${TAG_MAX_ITEMS} items`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    if (typeof tag !== 'string' || tag.length < 1 || tag.length > TAG_MAX_LENGTH) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags[${i}] must be 1..${TAG_MAX_LENGTH} characters`,
      );
    }
    if (tag.trim().length === 0) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags[${i}] cannot be whitespace-only`,
      );
    }
    if (seen.has(tag)) {
      throw new CollectionsError(
        'invalid_node_tags',
        `tags must be unique (duplicate "${tag}")`,
      );
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}
