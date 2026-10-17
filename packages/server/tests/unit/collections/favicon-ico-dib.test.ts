import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeFaviconImage } from '../../../src/modules/collections/application/favicon-image-decode.js';
import { BookmarkFaviconImageError } from '../../../src/modules/collections/application/favicon-store.js';

function icon(bits = 32, headerSize = 40, compression = 0, mask = true): Buffer {
  const colors = bits <= 8 ? 2 ** bits : 0;
  const maskBytes = compression === 0 || headerSize !== 40 ? 0 : (compression === 6 ? 16 : 12);
  const size = headerSize + maskBytes + colors * (headerSize === 12 ? 3 : 4)
    + Math.ceil(16 * bits / 32) * 4 * 16 + (mask ? 64 : 0);
  const ico = Buffer.alloc(22 + size);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico[6] = 16; ico[7] = 16;
  ico.writeUInt16LE(1, 10); ico.writeUInt16LE(bits, 12);
  ico.writeUInt32LE(size, 14); ico.writeUInt32LE(22, 18);
  const dib = ico.subarray(22);
  dib.writeUInt32LE(headerSize, 0);
  if (headerSize === 12) {
    dib.writeUInt16LE(16, 4); dib.writeUInt16LE(32, 6);
    dib.writeUInt16LE(1, 8); dib.writeUInt16LE(bits, 10);
  } else {
    dib.writeInt32LE(16, 4); dib.writeInt32LE(32, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(bits, 14);
    dib.writeUInt32LE(compression, 16);
    if (compression !== 0) {
      const masks = bits === 16 ? [0x7c00, 0x03e0, 0x001f] : [0x00ff0000, 0x0000ff00, 0x000000ff];
      masks.forEach((value, index) => dib.writeUInt32LE(value, 40 + index * 4));
      if (compression === 6) dib.writeUInt32LE(0xff000000, 52);
    }
  }
  return ico;
}

test('the 1150-byte 16×16 DIB ICO shape observed on S2 is accepted', () => {
  const ico = icon();
  assert.equal(ico.length, 1150);
  assert.deepEqual(decodeFaviconImage(ico), { mime: 'image/x-icon', width: 16, height: 16 });
});

test.each([1, 4, 8, 16, 24, 32])('uncompressed %i-bit DIB pixels and masks fit their declared ranges', (bits) => {
  assert.equal(decodeFaviconImage(icon(bits)).width, 16);
});

test.each([[4, 12, 0], [16, 40, 3], [32, 40, 6], [32, 108, 3], [32, 124, 0]])(
  'supports bits=%i, header=%i, compression=%i', (bits, header, compression) => {
    assert.equal(decodeFaviconImage(icon(bits, header, compression)).mime, 'image/x-icon');
  },
);

test('32-bit alpha may omit its mask, while other bit depths must provide one', () => {
  assert.equal(decodeFaviconImage(icon(32, 40, 0, false)).width, 16);
  assert.throws(() => decodeFaviconImage(icon(24, 40, 0, false)), /pixels or mask truncated/u);
});

test.each([
  [4, 17], [8, 16], [12, 2], [14, 15], [16, 1], [32, 1000],
])('rejects malformed DIB field at byte %i', (offset, value) => {
  const ico = icon();
  ico.writeUInt32LE(value, 22 + offset);
  assert.throws(() => decodeFaviconImage(ico), BookmarkFaviconImageError);
});

test('rejects overlapping bitfields, truncated pixels and partial AND masks', () => {
  const fields = icon(16, 40, 3);
  fields.writeUInt32LE(0x7c00, 22 + 44);
  assert.throws(() => decodeFaviconImage(fields), /bit masks invalid/u);
  for (const missing of [1, 65]) {
    const truncated = icon().subarray(0, 1150 - missing);
    truncated.writeUInt32LE(truncated.length - 22, 14);
    assert.throws(() => decodeFaviconImage(truncated), /pixels or mask truncated/u);
  }
});
