import { isIP } from 'node:net';

/** A trusted IPv6 client has one quota per /64; mapped IPv4 shares its IPv4 quota. */
export function rateLimitClientIp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  const address = value.replace(/^\[|\]$/gu, '').split('%', 1)[0]!;
  if (isIP(address) !== 6) return value;
  // URL serializes embedded IPv4 and compressed/expanded spelling consistently.
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const leading = left ? left.split(':') : [], trailing = right ? right.split(':') : [];
  const words = [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing]
    .map(word => Number.parseInt(word, 16));
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join('.');
  }
  return `${words.slice(0, 4).map(word => word.toString(16)).join(':')}::`;
}
