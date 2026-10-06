import { createHash, timingSafeEqual } from 'node:crypto';

import { CREDENTIAL_QUERY_PARAMETER_NAME_SET } from './credential-query-names.js';

const bearerScheme = 'bearer ';
const presentedBearerPattern = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/iu;
const token68Pattern = /^[A-Za-z0-9\-._~+/]+={0,}$/u;

/**
 * Denylisted query names, or a decoded name/value equal to the current bearer or
 * its standard single-space Bearer form (scheme case-insensitive).
 * Returns a reason code only — never the credential.
 */
export function credentialQueryDenial(
  entries: readonly (readonly [string, string])[],
  bearerToken: string,
  authorizationValues: readonly string[],
): 'credential_in_query' | undefined {
  const materials = bearerMaterials(bearerToken, authorizationValues);
  for (const [name, value] of entries) {
    if (CREDENTIAL_QUERY_PARAMETER_NAME_SET.has(name.toLowerCase())) return 'credential_in_query';
    if (materials.some((material) => valueCarriesBearer(name, material) || valueCarriesBearer(value, material))) return 'credential_in_query';
  }
  return undefined;
}

function bearerMaterials(upstreamToken: string, authorizationValues: readonly string[]): readonly string[] {
  const materials = [upstreamToken];
  if (authorizationValues.length !== 1) return materials;
  const presented = presentedBearer(authorizationValues[0]!);
  if (presented !== undefined && !secretEqual(presented, upstreamToken)) materials.push(presented);
  return materials;
}

function presentedBearer(authorization: string): string | undefined {
  const match = presentedBearerPattern.exec(authorization);
  if (match === null) return undefined;
  const token = match[1]!;
  return token68Pattern.test(token) ? token : undefined;
}

function valueCarriesBearer(value: string, token: string): boolean {
  if (secretEqual(value, token)) return true;
  if (value.length !== bearerScheme.length + token.length) return false;
  if (value.slice(0, bearerScheme.length).toLowerCase() !== bearerScheme) return false;
  return secretEqual(value.slice(bearerScheme.length), token);
}

function secretEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
