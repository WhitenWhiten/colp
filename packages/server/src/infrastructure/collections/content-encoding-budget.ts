/** Shared HTTP transfer-decoding bounds, independent of image pixel budgets. */
export const MAX_CONTENT_ENCODING_LAYERS = 2;
export const MAX_CONTENT_ENCODING_HEADER_LENGTH = 256;
const SUPPORTED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** Validate the entire chain before spending any decompression work. */
export function boundedContentEncodingLayers(value: string | null): string[] {
  if (value === null || value === '') return [];
  if (value.length > MAX_CONTENT_ENCODING_HEADER_LENGTH) {
    throw new RangeError('content-encoding header exceeds the decoding budget');
  }
  const layers = value.split(',').map(coding => coding.trim().toLowerCase())
    .filter(coding => coding.length > 0 && coding !== 'identity');
  if (layers.length > MAX_CONTENT_ENCODING_LAYERS) {
    throw new RangeError('content-encoding chain exceeds the decoding budget');
  }
  if (layers.some(coding => !SUPPORTED_ENCODINGS.has(coding))) {
    throw new TypeError('unsupported content-encoding');
  }
  return layers;
}
