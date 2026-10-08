import { BOOKMARK_FAVICON_MAX_BYTES } from './favicon-store.js';

/**
 * LP-01 link preview object limits. Previews are validated copies of the
 * page's own sharing image (og:image and relatives), never transcoded in v1.
 */
export const LINK_PREVIEW_MAX_IMAGE_BYTES = 2_097_152;
/** Decompressed PNG pixel budget for structural decode (bounded worker memory). */
export const LINK_PREVIEW_MAX_DECOMPRESSED_BYTES = 41_943_040;
/** Longest accepted side; matches the favicon decoder's hard dimension ceiling. */
export const LINK_PREVIEW_MAX_DIMENSION = 4096;

// A preview object must be able to hold anything a favicon can.
if (LINK_PREVIEW_MAX_IMAGE_BYTES < BOOKMARK_FAVICON_MAX_BYTES) {
  throw new Error('link preview byte cap must not be smaller than the favicon cap');
}
