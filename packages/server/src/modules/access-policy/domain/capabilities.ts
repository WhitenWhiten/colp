import type { CollectionCapability, MembershipRole } from './types.js';

/** All Phase 1 collection capabilities (closed set). */
export const ALL_COLLECTION_CAPABILITIES: readonly CollectionCapability[] = [
  'read_editor',
  'update_collection_metadata',
  'create_node',
  'update_node',
  'move_node',
  'delete_node',
  'manage_members',
  'manage_publication',
] as const;

/** Content mutation capabilities (editor+); excludes member and publication management. */
export const CONTENT_MUTATION_CAPABILITIES: readonly CollectionCapability[] = [
  'update_collection_metadata',
  'create_node',
  'update_node',
  'move_node',
  'delete_node',
] as const;

const OWNER_CAPABILITIES: ReadonlySet<CollectionCapability> = new Set(ALL_COLLECTION_CAPABILITIES);

const EDITOR_CAPABILITIES: ReadonlySet<CollectionCapability> = new Set([
  'read_editor',
  ...CONTENT_MUTATION_CAPABILITIES,
]);

const VIEWER_CAPABILITIES: ReadonlySet<CollectionCapability> = new Set(['read_editor']);

const ROLE_CAPABILITY_MATRIX: Readonly<Record<MembershipRole, ReadonlySet<CollectionCapability>>> = {
  owner: OWNER_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
};

/** Capabilities granted to a membership role. Default deny for unknown/null roles. */
export function capabilitiesForRole(role: MembershipRole | null): ReadonlySet<CollectionCapability> {
  if (role === null) return new Set();
  return ROLE_CAPABILITY_MATRIX[role] ?? new Set();
}

/** True when the role matrix grants the requested capability (default deny). */
export function roleGrantsCapability(
  role: MembershipRole | null,
  capability: CollectionCapability,
): boolean {
  return capabilitiesForRole(role).has(capability);
}
