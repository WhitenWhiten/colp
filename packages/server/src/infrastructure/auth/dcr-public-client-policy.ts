export interface DcrClientMetadataPolicyError {
  readonly error: 'invalid_client_metadata';
  readonly error_description: string;
}

function invalidClientMetadata(errorDescription: string): DcrClientMetadataPolicyError {
  return {
    error: 'invalid_client_metadata',
    error_description: errorDescription,
  };
}

/**
 * Know-N's unauthenticated DCR fallback is public-client-only. Better Auth's
 * RFC defaults intentionally allow omitted metadata to become a confidential
 * web client, so the product boundary must require these two declarations
 * before the upstream handler can mint a secret or persist a client.
 *
 * Malformed JSON is left to Better Auth's schema/error handling; it cannot
 * satisfy this policy or create a client.
 */
export function validateDcrPublicClientMetadata(
  body: Buffer | undefined,
  contentType: string,
): DcrClientMetadataPolicyError | null {
  if (contentType !== 'application/json') {
    return invalidClientMetadata('dynamic client registration requires application/json');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(body?.toString('utf8') ?? '');
  } catch {
    return null;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (record.token_endpoint_auth_method !== 'none') {
    return invalidClientMetadata('token_endpoint_auth_method must be explicitly set to none');
  }
  if (record.application_type !== 'native' && record.application_type !== 'web') {
    return invalidClientMetadata('application_type must be explicitly set to native or web');
  }
  return null;
}
