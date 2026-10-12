import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { boundedJson } from './schema.js';
import { NORMALIZER_VERSION } from './normalize.js';
import type { RuleDefinition, RoleBindings } from './types.generated.js';

export const DIGEST_VERSION = 'colp.automation.digest/v1' as const;
export function automationDigest(value: unknown): string {
  if (!boundedJson(value)) throw new TypeError('Digest requires bounded JSON.');
  const encoded = canonicalize({ version: DIGEST_VERSION, value });
  if (!encoded) throw new TypeError('Digest requires canonical JSON.');
  return bytesToHex(sha256(new TextEncoder().encode(encoded)));
}

export function ruleSemanticDigest(definition: RuleDefinition): string {
  const { name: _name, description: _description, roles, ...logic } = definition;
  return automationDigest({ ...logic, roles: roles.map(({ description: _label, ...role }) => role) });
}
export function bindingSemanticDigest(values: RoleBindings): string {
  return automationDigest(values);
}

export interface InputDigestIdentity {
  serverUuid: string;
  collectionId: string;
  nodeId: string;
  taskId: string;
  outputContract: string;
  revisions: Record<string, string | null>;
  inputFields: readonly string[];
  acceptedPredecessors: Readonly<Record<string, { resultId: string; digest: string }>>;
}
/** Caller supplies only relevant revisions, never a broad collection content revision for placement. */
export function taskInputDigest(identity: InputDigestIdentity, fields: Readonly<Record<string, unknown>>): string {
  const allowlist = [...new Set(identity.inputFields)].sort();
  const selected = Object.fromEntries(allowlist.map((field) => [field, fields[field] ?? null]));
  return automationDigest({ normalizer: NORMALIZER_VERSION, ...identity, inputFields: allowlist, fields: selected });
}
