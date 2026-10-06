/** JSON response media types understood by protocol JSON parsing boundaries. */
export type ProtocolJsonResponseMedia = 'json' | 'problem';

/** Registered Collection Protocol vendor JSON representation tokens. */
export type ProtocolVendorJsonResource = 'catalog' | 'collection' | 'snapshot' | 'node' | 'manifest';

const mediaTypes: Readonly<Record<ProtocolJsonResponseMedia, string>> = Object.freeze({
  json: 'application/json',
  problem: 'application/problem+json',
});

const vendorResources: Readonly<Record<ProtocolVendorJsonResource, true>> = Object.freeze({
  catalog: true,
  collection: true,
  snapshot: true,
  node: true,
  manifest: true,
});

/** Maps response definitions to the vendor representation registered for that wire document. */
export function protocolVendorJsonResourceForDefinition(
  definition: string,
): ProtocolVendorJsonResource | undefined {
  if (definition === 'manifest') return 'manifest';
  if (definition === 'collectionDirectory') return 'catalog';
  if (definition === 'collection' || definition === 'collectionMetadata') return 'collection';
  if (definition === 'snapshot') return 'snapshot';
  if (definition === 'node' || definition === 'nodeDetail') return 'node';
  return undefined;
}

export function protocolVendorJsonMediaType(resource: ProtocolVendorJsonResource): string {
  if (!vendorResources[resource]) throw new TypeError('Unknown protocol vendor JSON resource.');
  return `application/vnd.collection-protocol.${resource}+json;version=0.1`;
}

/**
 * Validates one response Content-Type at a boundary that is explicitly about to parse JSON.
 * The metadata must be present, unambiguous, UTF-8, and match either the generic or
 * registered representation media type. A JSON parsing boundary must not infer a media
 * type from response bytes.
 */
export function parseProtocolJsonResponseMediaType(
  value: string | null,
  expected: ProtocolJsonResponseMedia,
  resource?: ProtocolVendorJsonResource | null,
): string | null {
  if (value === null) {
    throw new TypeError(`Protocol JSON response must declare ${mediaTypes[expected]}.`);
  }
  const raw = value.trim();
  if (raw.length === 0 || raw.includes(',')) {
    throw new TypeError('Protocol JSON response Content-Type is ambiguous.');
  }

  const parts = raw.split(';');
  const type = parts.shift()?.trim().toLowerCase() ?? '';
  const vendorMatch = /^application\/vnd\.collection-protocol\.([a-z][a-z0-9-]*)\+json$/u.exec(type);
  const vendorResource = vendorMatch?.[1]?.toLowerCase() as ProtocolVendorJsonResource | undefined;
  const vendor = vendorResource !== undefined && vendorResources[vendorResource] === true;
  // `undefined` is useful to validate a vendor declaration in isolation. A JSON
  // endpoint with no registered representation passes `null` to disallow one.
  const expectedVendor = resource !== null && (resource === undefined || vendorResource === resource);

  if (expected === 'problem') {
    if (type !== mediaTypes.problem) {
      throw new TypeError(`Protocol Problem response must use ${mediaTypes.problem}.`);
    }
  } else if (type !== mediaTypes.json && !(vendor && expectedVendor)) {
    throw new TypeError(`Protocol JSON response must use ${mediaTypes.json} or its registered vendor media type.`);
  }

  let charset: string | undefined;
  let version: string | undefined;
  let profileSeen = false;
  for (const parameter of parts) {
    const separator = parameter.indexOf('=');
    if (separator <= 0) throw new TypeError('Protocol JSON response Content-Type has an invalid parameter.');
    const name = parameter.slice(0, separator).trim().toLowerCase();
    const parameterValue = parameter.slice(separator + 1).trim();
    if (name === 'profile' && expected === 'problem') {
      if (profileSeen || parameterValue.length === 0) {
        throw new TypeError('Protocol Problem response Content-Type has an invalid or duplicate profile parameter.');
      }
      profileSeen = true;
      continue;
    }
    if (name === 'version' && vendor) {
      if (version !== undefined || parameterValue !== '0.1') {
        throw new TypeError('Protocol vendor JSON media type requires version=0.1.');
      }
      version = parameterValue;
      continue;
    }
    if (name !== 'charset' || parameterValue.length === 0 || charset !== undefined) {
      throw new TypeError('Protocol JSON response Content-Type has an unsupported or duplicate parameter.');
    }
    const quoted = parameterValue.startsWith('"') && parameterValue.endsWith('"');
    const unquoted = quoted ? parameterValue.slice(1, -1) : parameterValue;
    if (unquoted.length === 0 || /[\r\n]/u.test(unquoted)) {
      throw new TypeError('Protocol JSON response Content-Type has an invalid charset.');
    }
    charset = unquoted.toLowerCase();
  }

  if (vendor && version !== '0.1') {
    throw new TypeError('Protocol vendor JSON media type requires version=0.1.');
  }
  if (charset !== undefined && charset !== 'utf-8') {
    throw new TypeError('Protocol JSON responses must use UTF-8.');
  }
  return type;
}
