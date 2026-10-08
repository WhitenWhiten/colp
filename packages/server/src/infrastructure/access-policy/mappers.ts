import {
  AccessPolicyError,
  type CollectionVisibility,
  type MembershipRole,
  type ResourcePolicyFacts,
} from '../../modules/access-policy/index.js';

const MEMBERSHIP_ROLES = new Set<MembershipRole>(['owner', 'editor', 'viewer']);
const VISIBILITIES = new Set<CollectionVisibility>([
  'private',
  'protected',
  'public',
  'unlisted',
]);

export interface CollectionFactsRow {
  readonly id: string;
  readonly owner_subject_id: string;
  readonly visibility: string;
  readonly policy_revision: string;
  readonly deleted_at: Date | null;
  readonly membership_role: string | null;
}

export function mapMembershipRole(value: string | null): MembershipRole | null {
  if (value === null) return null;
  if (!MEMBERSHIP_ROLES.has(value as MembershipRole)) {
    throw new AccessPolicyError(
      'invalid_membership_role',
      `unsupported membership role: ${value}`,
    );
  }
  return value as MembershipRole;
}

export function mapVisibility(value: string): CollectionVisibility {
  if (!VISIBILITIES.has(value as CollectionVisibility)) {
    throw new AccessPolicyError(
      'invalid_visibility',
      `unsupported collection visibility: ${value}`,
    );
  }
  return value as CollectionVisibility;
}

export function mapCollectionFacts(row: CollectionFactsRow): ResourcePolicyFacts {
  return {
    collectionId: row.id,
    ownerSubjectId: row.owner_subject_id,
    visibility: mapVisibility(row.visibility),
    policyRevision: row.policy_revision,
    membershipRole: mapMembershipRole(row.membership_role),
    deleted: row.deleted_at !== null,
  };
}
