/** Same ceiling as the product identity HttpsUrl contract. */
const AVATAR_URL_MAX = 2048;
const DATA_AVATAR_MAX = 128 * 1_024;
const INLINE_AVATAR_MAX_BYTES = 96 * 1_024;
const DATA_AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u;

function hasUnsafeChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Accept only a strict https avatar URL: no userinfo, fragment, or non-default
 * port. Invalid values (javascript:, data:, http) become undefined so the
 * letter fallback stays the only other paint.
 */
export function parseHttpsAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 8 || value.length > AVATAR_URL_MAX || hasUnsafeChars(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
        || parsed.port !== '' || parsed.href.includes('#')) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Product `/me` avatars are same-origin, including local http://127.0.0.1:port.
 * Provider CDN photos stay on the strict https parser.
 */
export function parseTrustedAvatarUrl(value: unknown, serverOrigin: string): string | undefined {
  if (typeof value !== 'string' || value.length < 8 || value.length > AVATAR_URL_MAX || hasUnsafeChars(value)) {
    return undefined;
  }
  try {
    const origin = new URL(serverOrigin);
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        || parsed.origin !== origin.origin || parsed.username !== '' || parsed.password !== ''
        || parsed.hash !== '') {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** `/me` may carry an IdP CDN photo or a same-origin product object. */
export function parseRemoteAvatarUrl(value: unknown, serverOrigin: string): string | undefined {
  return parseHttpsAvatarUrl(value) ?? parseTrustedAvatarUrl(value, serverOrigin);
}

export function parseDataAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 32 || value.length > DATA_AVATAR_MAX) return undefined;
  return DATA_AVATAR.test(value) ? value : undefined;
}

export function parsePaintAvatarUrl(value: unknown, serverOrigin?: string): string | undefined {
  return parseDataAvatarUrl(value)
    ?? parseHttpsAvatarUrl(value)
    ?? (serverOrigin ? parseTrustedAvatarUrl(value, serverOrigin) : undefined);
}

export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/** SW-side inlining so extension pages do not have to fetch a cross-site object. */
export async function inlineAvatarDataUrl(
  href: string, fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(href, {
      method: 'GET', credentials: 'omit', cache: 'force-cache', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 32 || bytes.byteLength > INLINE_AVATAR_MAX_BYTES) return undefined;
    const type = sniffImageType(bytes);
    if (!type) return undefined;
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return parseDataAvatarUrl(`data:${type};base64,${btoa(binary)}`);
  } catch {
    return undefined;
  }
}
