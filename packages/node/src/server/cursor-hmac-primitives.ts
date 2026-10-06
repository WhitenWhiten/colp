import type { Hmac } from 'node:crypto';

export function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
      decoded.fill(0);
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

export function updateFrame(mac: Hmac, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  mac.update(length);
  mac.update(value);
  length.fill(0);
}

export function updateInteger(mac: Hmac, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  mac.update(encoded);
  encoded.fill(0);
}

export function updateOptionalFrame(mac: Hmac, value: Buffer | undefined): void {
  mac.update(Uint8Array.of(value === undefined ? 0 : 1));
  if (value !== undefined) updateFrame(mac, value);
}

export function updateOptionalInteger(mac: Hmac, value: number | undefined): void {
  mac.update(Uint8Array.of(value === undefined ? 0 : 1));
  if (value !== undefined) updateInteger(mac, value);
}
