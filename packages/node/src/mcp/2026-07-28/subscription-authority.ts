/** Resource-specific, fail-closed checks, used at start and before every send.
 * Type-only dependencies keep this predicate independently testable.
 */
export interface ListenAuthorization<Context> {
  readonly isAuthorized: (context: Context) => boolean;
  readonly isResourceAuthorized?: (context: Context, resourceUri: string) => boolean;
}

export function isListenAuthorized<Context>(
  context: Context,
  resourceUris: readonly string[] | undefined,
  authorization: ListenAuthorization<Context>,
): boolean {
  try {
    if (authorization.isAuthorized(context) !== true) return false;
    if (resourceUris === undefined || resourceUris.length === 0) return true;
    const check = authorization.isResourceAuthorized;
    if (typeof check !== 'function') return false;
    return resourceUris.every(uri => check.call(authorization, context, uri) === true);
  } catch {
    // Errors and non-boolean answers must not keep a stream authorized.
    return false;
  }
}
