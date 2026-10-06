/** Validate the single quoted entity-tag used by Publication cache validators. */
export function validatePublicationIfNoneMatchEtag(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Publication ETag must be a quoted entity-tag.');
  }
  // A single strong opaque-tag is required here. Commas are valid etagc inside
  // the surrounding quotes and remain unambiguous when sent verbatim.
  if (value.includes('\r') || value.includes('\n')) {
    throw new TypeError('Publication ETag contains an unsafe delimiter.');
  }
  if (!/^"[\x21\x23-\x7E\x80-\u00FF]*"$/u.test(value)) {
    throw new TypeError('Publication ETag must be a strictly quoted entity-tag.');
  }
  return value;
}
