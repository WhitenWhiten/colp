import {
  CanonicalMutationInvariantError,
  type JsonObject,
  type ResourceOwnedFields,
} from './canonical-mutation.js';

/** Top-level wire fields rebuilt from authoritative relational columns. */
export const RELATIONAL_OWNER_FIELDS = Object.freeze([
  'id',
  'collection',
  'collectionId',
  'collection_id',
  'parent',
  'parentId',
  'parent_id',
  'position',
  'positionToken',
  'position_token',
  'revision',
  'resourceRevision',
  'resource_revision',
  'childrenRevision',
  'children_revision',
  'contentRevision',
  'content_revision',
  'policyRevision',
  'policy_revision',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
] as const);

const relationalOwnerFields = new Set<string>(RELATIONAL_OWNER_FIELDS);

function assertPlainObject(value: JsonObject, path: string): void {
  if (Array.isArray(value)) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      `${path} must be a plain JSON object`,
    );
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalMutationInvariantError(
      'invalid_canonical_mutation',
      `${path} must be a plain JSON object`,
    );
  }
}

export function assertResourceFieldAuthority(fields: ResourceOwnedFields): void {
  assertPlainObject(fields.kindFields, 'kindFields');
  assertPlainObject(fields.extensions, 'extensions');

  for (const field of Object.keys(fields.kindFields)) {
    if (relationalOwnerFields.has(field)) {
      throw new CanonicalMutationInvariantError(
        'resource_field_authority_violation',
        `kindFields.${field} is owned by authoritative relational state`,
      );
    }
  }
}
