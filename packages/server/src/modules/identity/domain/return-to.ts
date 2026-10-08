import { IdentityError } from './errors.js';

const MAX_RETURN_TO_LENGTH = 2048;
/**
 * Relative-path checks have no caller origin. Inputs that are not a single-slash
 * path are rejected before this base is used, so it is not an accepted callback.
 */
const RELATIVE_RETURN_TO_BASE = 'https://return-to.invalid';

/**
 * Shared return/callback canonicalization for the domain helper, browser
 * transport, and Better Auth bridge.
 *
 * Accepts a relative path or an absolute URL on `productOrigin` and returns
 * `pathname + search + hash`. Rejects a different final origin, userinfo,
 * a pathname that starts with `//` after URL normalization (`/.//`, encoded
 * dot segments), literal or percent-decoded backslashes and control
 * characters, and invalid percent-encoding.
 */
export function canonicalizeSafeReturnTo(raw: unknown, productOrigin: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return null;
  if (raw.startsWith('//') || raw.includes('\\') || hasControlChars(raw)) return null;
  if (percentDecodedHazards(raw)) return null;

  let product: URL;
  try {
    product = new URL(productOrigin);
  } catch {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw, product);
  } catch {
    return null;
  }
  if (resolved.origin !== product.origin) return null;
  if (resolved.username !== '' || resolved.password !== '') return null;

  const out = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  if (!out.startsWith('/') || out.startsWith('//') || out.includes('\\') || hasControlChars(out)) {
    return null;
  }
  if (decodedPathnameUnsafe(resolved.pathname)) return null;
  return out;
}

/**
 * Relative returnTo shape. Absolute URLs are rejected here; origin equality
 * belongs to {@link canonicalizeSafeReturnTo}.
 */
export function isSafeRelativeReturnTo(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  return canonicalizeSafeReturnTo(value, RELATIVE_RETURN_TO_BASE) !== null;
}

/** Returns the canonical relative path, or throws `invalid_return_to`. */
export function assertSafeRelativeReturnTo(value: string): string {
  const canonical = typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? canonicalizeSafeReturnTo(value, RELATIVE_RETURN_TO_BASE)
    : null;
  if (canonical === null) {
    throw new IdentityError('invalid_return_to', 'returnTo must be a safe relative path');
  }
  return canonical;
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function percentDecodedHazards(value: string): boolean {
  try {
    const decoded = strictPercentDecode(value);
    return decoded.includes('\\') || hasControlChars(decoded);
  } catch {
    return true;
  }
}

function decodedPathnameUnsafe(pathname: string): boolean {
  try {
    const decoded = strictPercentDecode(pathname);
    return decoded.startsWith('//') || decoded.includes('\\') || hasControlChars(decoded);
  } catch {
    return true;
  }
}

/** Rejects incomplete or invalid percent-encoding rather than soft-failing. */
function strictPercentDecode(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})|%[^0-9A-Fa-f]|%$/g, (match, hex: string | undefined) => {
    if (hex === undefined) {
      throw new TypeError('invalid percent-encoding');
    }
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}
