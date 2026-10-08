import { parseSessionCookieField } from '../session-cookie.js';

export type ColpAuthorizationDenial = 'authentication_required' | 'invalid_json';

/**
 * Prefer `__Host-known_session` when present: Chromium may percent-encode
 * `+`/`=` inside Authorization while still forwarding a valid Cookie header
 * (e55da388). Duplicate Cookie headers, a duplicate session pair, or a
 * decode failure fail closed as `invalid_json` — the same 400 used for
 * duplicate Authorization. Cookie wins over a mangled Bearer.
 */
export function colpAuthorizationFromRawHeaders(
  fields: ReadonlyMap<string, readonly string[]>,
): { readonly authorization: string } | { readonly denial: ColpAuthorizationDenial } {
  const cookies = fields.get('cookie') ?? [];
  if (cookies.length > 1) return { denial: 'invalid_json' };
  if (cookies.length === 1) {
    const parsed = parseSessionCookieField(cookies[0]!);
    if (parsed.kind === 'parse-error') return { denial: 'invalid_json' };
    if (parsed.kind === 'present') return { authorization: `Bearer ${parsed.raw}` };
  }
  const values = fields.get('authorization') ?? [];
  if (values.length === 0) return { denial: 'authentication_required' };
  if (values.length !== 1 || values[0]!.includes(',')
      || !/^[\x20-\x7e]+$/u.test(values[0]!) || values[0]!.trim() !== values[0]!) {
    return { denial: 'invalid_json' };
  }
  return { authorization: values[0]! };
}

export function requireColpAuthorization<E extends Error>(
  fields: ReadonlyMap<string, readonly string[]>,
  deny: (code: ColpAuthorizationDenial) => E,
): string {
  const admitted = colpAuthorizationFromRawHeaders(fields);
  if ('denial' in admitted) throw deny(admitted.denial);
  return admitted.authorization;
}
