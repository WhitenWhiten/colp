/** A response binds the body to its cookie user in the same authenticated read.
 * Legacy servers without separate auth-user identity keep their account header. */
export function responseBelongsToAuthUser(response: Response, authUserId: string, legacyAccountHeader: string): boolean {
  const owner = response.headers.get('Known-Auth-User-Id');
  return authUserId.length > 0 && (owner ?? response.headers.get(legacyAccountHeader)) === authUserId;
}
