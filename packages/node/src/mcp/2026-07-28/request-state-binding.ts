/**
 * Canonical bytes for the MCP requestState binding tag (version v1).
 *
 * Already-validated authenticated binding fields are encoded in a fixed order
 * as uint32-BE UTF-16 code-unit counts followed by UTF-16BE code units, then
 * prefixed by {@link REQUEST_STATE_BINDING_DOMAIN}. `|`, controls, empty
 * strings, non-BMP characters, and unpaired surrogates stay distinct; a utf8
 * HMAC of those strings would collapse an unpaired surrogate into U+FFFD.
 *
 * The v0 domain `mcp.requestState.bind:` plus `|` join is not accepted. A
 * state that fails verification is rejected and does not mint a replacement
 * Plan. requestState TTL is unchanged (default 600 seconds). Resuming an
 * existing Plan still requires a v1 state for that same Plan.
 */
import type { McpAuthenticatedAuthorizationBinding } from '../shared/authorization.js';

export const REQUEST_STATE_BINDING_DOMAIN = 'mcp.requestState.bind.v1';

/** Hard ceilings for authenticated binding material before Buffer allocation. */
export const REQUEST_STATE_BINDING_MAX_FIELD_LENGTH = 4_096;
export const REQUEST_STATE_BINDING_MAX_BYTES = 16 * 1024;

const BINDING_FIELDS = [
  'kind',
  'principalId',
  'clientId',
  'credentialBindingId',
  'resourceAudience',
  'securityEpoch',
] as const;

export function requestStateBindingMaterial(
  binding: McpAuthenticatedAuthorizationBinding,
): Uint8Array {
  const fields = BINDING_FIELDS.map((name) => binding[name]);
  const domain = Buffer.from(REQUEST_STATE_BINDING_DOMAIN, 'ascii');
  let payloadBytes = 0;
  for (const field of fields) {
    if (typeof field !== 'string' || field.length > REQUEST_STATE_BINDING_MAX_FIELD_LENGTH) {
      throw new TypeError('MCP requestState binding field exceeds its length budget.');
    }
    payloadBytes += 4 + field.length * 2;
  }
  if (domain.length + payloadBytes > REQUEST_STATE_BINDING_MAX_BYTES) {
    throw new TypeError('MCP requestState binding exceeds its byte budget.');
  }
  const out = Buffer.alloc(domain.length + payloadBytes);
  domain.copy(out, 0);
  let offset = domain.length;
  for (const field of fields) {
    offset = out.writeUInt32BE(field.length, offset);
    for (let index = 0; index < field.length; index += 1) {
      offset = out.writeUInt16BE(field.charCodeAt(index), offset);
    }
  }
  return new Uint8Array(out);
}
