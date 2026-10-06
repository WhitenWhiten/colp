/**
 * Canonical credential query-parameter names shared by API-key and OAuth
 * transport guards (SEC-0008 / SEC-0009).
 *
 * Matching is case-insensitive: guards compare `name.toLowerCase()` against
 * these lowercase spellings. The API-key built-in list is the source of truth
 * and includes `access_token`, `token`, `id_token`, `refresh_token`, and
 * common aliases. OAuth also rejects a decoded value equal to the current
 * bearer; that check is not a name in this list and is not authentication.
 *
 * **False-deny note:** the short names `key` and `token` are intentionally
 * included, as are `id_token` and `refresh_token`. OAuth and API-key routes
 * that legitimately use those names for a non-credential purpose will fail
 * closed with `credential_in_query`. Prefer non-credential query names on
 * those routes rather than narrowing this denylist.
 *
 * Callers may add deployment-specific names via
 * `ApiKeyTransportInput.credentialQueryParameterNames`; those extras are not
 * part of this frozen list.
 */
export const CREDENTIAL_QUERY_PARAMETER_NAMES = Object.freeze([
  'access_token',
  'access-token',
  'accesstoken',
  'api_key',
  'api-key',
  'apikey',
  'authorization',
  'key',
  'x-api-key',
  'x_api_key',
  'xapikey',
  'token',
  'id_token',
  'refresh_token',
] as const);

export type CredentialQueryParameterName =
  (typeof CREDENTIAL_QUERY_PARAMETER_NAMES)[number];

/**
 * Set view of {@link CREDENTIAL_QUERY_PARAMETER_NAMES} for O(1) membership
 * checks after lowercasing a decoded query name.
 */
export const CREDENTIAL_QUERY_PARAMETER_NAME_SET: ReadonlySet<string> = new Set(
  CREDENTIAL_QUERY_PARAMETER_NAMES,
);
