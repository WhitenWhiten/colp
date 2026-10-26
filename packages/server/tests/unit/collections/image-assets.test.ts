import { describe, expect, test } from 'vitest';
import { imageAssetUrl, parseCoverPreference, validateCoverImage, IMAGE_MAX_BYTES } from '../../../src/modules/collections/index.js';
import { makePng } from '../../support/link-preview-fixtures.js';

describe('durable cover images', () => {
  test('decodes uploaded images without the OG minimum-size filter', () => {
    expect(validateCoverImage(makePng(32, 16))).toMatchObject({ mime: 'image/png', width: 32, height: 16 });
    expect(() => validateCoverImage(Buffer.from('not a png'))).toThrow('could not be decoded');
    expect(() => validateCoverImage(Buffer.alloc(IMAGE_MAX_BYTES + 1))).toThrow('2 MiB');
    const corrupt = makePng(32, 16);
    corrupt[40] = corrupt[40]! ^ 1;
    expect(() => validateCoverImage(corrupt)).toThrow('could not be decoded');
  });
  test('validates custom-only bindings and closed settings', () => {
    const id = '12345678-1234-4234-8234-123456789abc';
    expect(parseCoverPreference({ mode: 'custom', assetId: id })).toEqual({ mode: 'custom', assetId: id });
    expect(parseCoverPreference({ mode: 'auto' })).toEqual({ mode: 'auto', assetId: null });
    for (const value of [{ mode: 'custom' }, { mode: 'none', assetId: id }, { mode: 'fallback' }, { mode: 'auto', url: 'https://outside' }]) {
      expect(() => parseCoverPreference(value)).toThrow();
    }
    expect(imageAssetUrl('https://known.example', id)).toBe(`https://known.example/api/v1/images/${id}`);
    expect(() => imageAssetUrl('https://known.example', '../outside')).toThrow();
  });
});
