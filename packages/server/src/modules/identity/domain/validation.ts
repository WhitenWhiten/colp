import { IdentityError } from './errors.js';

const HANDLE_PATTERN = /^[A-Za-z0-9._~-]{1,64}$/;
const DISPLAY_NAME_MAX = 120;
/** Shared bound for profile about text: application validation, defensive public read, DB CHECK. */
export const ABOUT_MAX = 2000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 320;
const AVATAR_URL_MAX = 2048;
/** Public avatar object path: `{origin}/api/v1/avatar/{uuid}` (same pattern as the GET route). */
const SAME_ORIGIN_AVATAR_PATH_PATTERN = /^\/api\/v1\/avatar\/[a-f0-9-]{36}$/iu;

/** Product handle input: 1..64 URL-safe characters; public identity is lowercase. */
export function assertValidHandle(handle: string): string {
  if (!HANDLE_PATTERN.test(handle) || handle === '.' || handle === '..') {
    throw new IdentityError(
      'invalid_handle',
      'handle must be 1..64 characters of [A-Za-z0-9._~-]',
    );
  }
  return handle;
}

/**
 * Longest handle a new claim may take. The stored column, the OpenAPI schema
 * and assertValidHandle still accept 64 so handles minted under the retired
 * opaque scheme keep resolving; this is the forward-looking bound that keeps
 * `@handle` from overflowing the identity rows that render it.
 */
export const HANDLE_CLAIM_MAX = 30;

/**
 * Handles that would let an account pose as the product, its operators, or an
 * automated sender. Public profiles live under `/u/{handle}`, so these never
 * shadow an application route — the risk being closed here is impersonation,
 * not routing.
 */
const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'abuse', 'admin', 'administrator', 'admins', 'api', 'billing',
  'help', 'helpdesk', 'hostmaster', 'know-n', 'known', 'known-app',
  'known-team', 'knownapp', 'legal', 'mailer-daemon', 'mod', 'moderator',
  'moderators', 'mods', 'no-reply', 'noreply', 'official', 'postmaster',
  'privacy', 'root', 'security', 'settings', 'signin', 'signup',
  'staff', 'support', 'sysadmin', 'system', 'team', 'terms',
  'trust', 'verify', 'webmaster', 'www',
]);

/**
 * Policy for a handle an account is about to take, layered on top of the
 * charset contract in assertValidHandle. Expects the canonical lowercase form.
 *
 * Applied only where a handle actually changes hands, so an account still
 * holding a longer legacy handle can re-save the rest of its profile without
 * being forced to rename.
 */
export function assertClaimableHandle(handle: string): string {
  if (handle.length > HANDLE_CLAIM_MAX) {
    throw new IdentityError(
      'invalid_handle',
      `handle must be at most ${HANDLE_CLAIM_MAX} characters`,
    );
  }
  if (RESERVED_HANDLES.has(handle)) {
    throw new IdentityError('invalid_handle', 'this handle is reserved');
  }
  return handle;
}

/**
 * Product displayName is 1..120 when set for MeView.
 * Empty string remains valid for bootstrap profiles.
 */
export function assertValidDisplayName(displayName: string, options: {
  readonly allowEmpty?: boolean;
} = {}): string {
  const allowEmpty = options.allowEmpty ?? true;
  if (displayName.length > DISPLAY_NAME_MAX) {
    throw new IdentityError(
      'invalid_display_name',
      `displayName must be at most ${DISPLAY_NAME_MAX} characters`,
    );
  }
  if (!allowEmpty && displayName.length === 0) {
    throw new IdentityError('invalid_display_name', 'displayName is required');
  }
  if (displayName.length > 0 && displayName.trim().length === 0) {
    throw new IdentityError('invalid_display_name', 'displayName cannot be whitespace-only');
  }
  return displayName;
}

/**
 * Product about is 0..ABOUT_MAX. Empty string remains valid (unset).
 * Whitespace-only values are rejected.
 */
export function assertValidAbout(about: string): string {
  if (about.length > ABOUT_MAX) {
    throw new IdentityError(
      'invalid_about',
      `about must be at most ${ABOUT_MAX} characters`,
    );
  }
  if (about.length > 0 && about.trim().length === 0) {
    throw new IdentityError('invalid_about', 'about cannot be whitespace-only');
  }
  return about;
}

export function assertValidEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  if (email.length === 0 || email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
    throw new IdentityError('invalid_email', 'email is not a valid address');
  }
  return email;
}

/**
 * Strict HttpsUrl check for avatar URLs (docs/08 §7.3): an absolute https URI,
 * no userinfo, no fragment, no explicit non-default port, and a canonical
 * value of at most AVATAR_URL_MAX characters.
 *
 * Uses the WHATWG URL parser (never string prefixes): IDN hosts normalize to
 * punycode, default ports are dropped, userinfo is detected in plain and
 * percent-encoded form, and the parser's silent stripping of tab/newline is
 * neutralized by a raw control-character check before parsing. Returns the
 * canonical serialization, or null when the value is not compliant.
 */
function parseStrictHttpsAvatarUrl(value: string): string | null {
  // The URL parser strips tab/newline from its input, which would silently
  // rewrite e.g. "https://exa\nmple.com/" into a different host; reject any
  // raw control character (C0 + DEL) before parsing.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // An empty fragment is still a fragment: the parser reports hash === '' for
  // a trailing '#' while the canonical href keeps the delimiter, so reject any
  // '#' in the serialization rather than only non-empty hash values.
  if (parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.href.includes('#')) {
    return null;
  }
  const canonical = parsed.href;
  if (canonical.length > AVATAR_URL_MAX) return null;
  return canonical;
}

/** Non-throwing HttpsUrl predicate for fail-closed read adapters. */
export function isValidAvatarUrl(value: string): boolean {
  return parseStrictHttpsAvatarUrl(value) !== null;
}

export function assertValidAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (avatarUrl === null || avatarUrl === undefined) return null;
  if (avatarUrl.length === 0) {
    throw new IdentityError('invalid_identity_input', 'avatarUrl cannot be empty string');
  }
  const canonical = parseStrictHttpsAvatarUrl(avatarUrl);
  if (canonical === null) {
    throw new IdentityError(
      'invalid_identity_input',
      'avatarUrl must be an absolute https URL without userinfo, fragment, or non-default port, at most '
        + `${AVATAR_URL_MAX} characters`,
    );
  }
  return canonical;
}

/**
 * Same-origin avatar URL policy for USER-SUPPLIED avatar URLs (avatar audit
 * #6 / S8): the strict HttpsUrl contract above must hold AND the URL must
 * point at this product's own public avatar route
 * `{productOrigin}/api/v1/avatar/{uuid}` (uuid matches the public GET
 * route's pattern). External https URLs (CDNs, gravatar, ...) are rejected
 * because rendering them in other users' browsers would leak visitor IPs to
 * the foreign host. OIDC claim sync must keep using assertValidAvatarUrl —
 * IdP picture claims are legitimately external CDN URLs. null/undefined
 * return null; preserve-vs-clear semantics belong to the caller.
 */
export function assertSameOriginAvatarUrl(
  avatarUrl: string | null | undefined,
  productOrigin: string,
): string | null {
  if (avatarUrl === null || avatarUrl === undefined) return null;
  const canonical = assertValidAvatarUrl(avatarUrl);
  // Narrowing guard: assertValidAvatarUrl only returns null for null/undefined
  // input, which is already handled above; keep the check so the compiler can
  // prove `canonical` is a string for the URL construction below.
  if (canonical === null) return null;
  let origin: URL;
  try {
    origin = new URL(productOrigin);
  } catch {
    throw new IdentityError(
      'invalid_identity_input',
      'avatarUrl must be a same-origin /api/v1/avatar/<uuid> URL',
    );
  }
  const url = new URL(canonical);
  if (url.origin !== origin.origin || !SAME_ORIGIN_AVATAR_PATH_PATTERN.test(url.pathname)) {
    throw new IdentityError(
      'invalid_identity_input',
      'avatarUrl must be a same-origin /api/v1/avatar/<uuid> URL',
    );
  }
  return canonical;
}

export function assertNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new IdentityError('invalid_identity_input', `${field} is required`);
  }
  return value;
}
