export const MAX_OAUTH_CLIENT_NAME_LENGTH = 128;

/** DCR names are optional, but cannot carry an unbounded display payload. */
export function validOAuthClientName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_OAUTH_CLIENT_NAME_LENGTH * 2) return false;
  return [...value].length <= MAX_OAUTH_CLIENT_NAME_LENGTH;
}

/** Bounds legacy registrations and externally discovered names without splitting a surrogate pair. */
export function oauthClientDisplayName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const name = value.trim(); if (!name) return undefined;
  let result = ''; let length = 0;
  for (const character of name) {
    if (++length > MAX_OAUTH_CLIENT_NAME_LENGTH) break;
    result += character;
  }
  return result;
}
