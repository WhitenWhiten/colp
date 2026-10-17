import { BookmarkFaviconImageError } from './favicon-store.js';

function invalid(message: string): never { throw new BookmarkFaviconImageError(message); }

/** ICO stores a DIB without BITMAPFILEHEADER; its height includes the AND mask. */
export function validateIcoDib(payload: Buffer, width: number, height: number): void {
  // Retain compatibility with the full-BMP representation accepted previously.
  const offset = payload.subarray(0, 2).toString('latin1') === 'BM' ? 14 : 0;
  if (payload.length < offset + 12) invalid('ICO DIB header truncated');
  const headerSize = payload.readUInt32LE(offset);
  const core = headerSize === 12;
  if (![12, 40, 52, 56, 108, 124].includes(headerSize) || payload.length < offset + headerSize) {
    invalid('ICO DIB header unsupported or truncated');
  }
  const dibWidth = core ? payload.readUInt16LE(offset + 4) : payload.readInt32LE(offset + 4);
  const dibHeight = core ? payload.readUInt16LE(offset + 6) : payload.readInt32LE(offset + 8);
  if (dibWidth !== width || (dibHeight !== height * 2 && !(offset === 14 && dibHeight === height))) {
    invalid('ICO embedded DIB dimensions do not match the directory');
  }
  const planes = payload.readUInt16LE(offset + (core ? 8 : 12));
  const bits = payload.readUInt16LE(offset + (core ? 10 : 14));
  const compression = core ? 0 : payload.readUInt32LE(offset + 16);
  if (planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits)
    || ![0, 3, 6].includes(compression) || (compression !== 0 && bits !== 16 && bits !== 32)) {
    invalid('ICO DIB pixel format unsupported');
  }
  let dataOffset = offset + headerSize;
  if (compression !== 0) {
    const maskCount = compression === 6 ? 4 : 3;
    const masksOffset = headerSize === 40 ? dataOffset : offset + 40;
    if ((headerSize !== 40 && headerSize < 40 + maskCount * 4) || payload.length < masksOffset + maskCount * 4) {
      invalid('ICO DIB bit masks truncated');
    }
    let used = 0;
    for (let index = 0; index < maskCount; index += 1) {
      const mask = payload.readUInt32LE(masksOffset + index * 4);
      if (mask === 0 || (mask & used) !== 0 || (bits === 16 && mask > 0xffff)) invalid('ICO DIB bit masks invalid');
      used |= mask;
    }
    if (headerSize === 40) dataOffset += maskCount * 4;
  }
  const colors = core ? (bits <= 8 ? 2 ** bits : 0) : payload.readUInt32LE(offset + 32) || (bits <= 8 ? 2 ** bits : 0);
  if (colors > (bits <= 8 ? 2 ** bits : 256)) invalid('ICO DIB palette exceeds its pixel format');
  dataOffset += colors * (core ? 3 : 4);
  if (offset === 14) {
    const declaredOffset = payload.readUInt32LE(10);
    if (declaredOffset < dataOffset) invalid('ICO BMP pixel offset overlaps its header');
    dataOffset = declaredOffset;
  }
  const pixelsEnd = dataOffset + Math.ceil(width * bits / 32) * 4 * height;
  const maskEnd = pixelsEnd + Math.ceil(width / 32) * 4 * height;
  // A 32-bit alpha icon may omit the AND mask; a partial mask is never valid.
  if (payload.length < pixelsEnd || (payload.length < maskEnd && !(bits === 32 && payload.length === pixelsEnd))) {
    invalid('ICO DIB pixels or mask truncated');
  }
}
