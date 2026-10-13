import type { EventFacts, RuleDefinition } from '@know-n/colp/automation';
import { sameFolder, type FolderResolution } from '../domain/bindings.js';

/** Only dependencies used by this stage may block it, including ancestor constraints. */
export function intakeDependencyRoles(definition: RuleDefinition): Set<string> {
  const used = new Set([definition.scope.folderRole, definition.intake?.folderRole].filter((role): role is string => !!role));
  for (const key of used) {
    const ancestor = definition.roles.find((role) => role.key === key)?.mustBeWithinRole;
    if (ancestor) used.add(ancestor);
  }
  return used;
}
export function intakeBindingsAvailable(definition: RuleDefinition, resolutions: Record<string, FolderResolution>): boolean {
  return [...intakeDependencyRoles(definition)].every((role) => resolutions[role]?.status === 'valid');
}
/** Apply the same admission checks to the proposed rule and every competitor. No I/O. */
export function eventEligible(definition: RuleDefinition, resolutions: Record<string, FolderResolution>, event: EventFacts): boolean {
  // BE-1 previews the intake stage. Other automation stages may continue into it.
  if (event.origin === 'restore' || (event.origin === 'automation' && event.stageId === 'intake')
    || (event.origin === 'import' && definition.policy.imports === 'exclude') || event.hopCount >= definition.policy.maxHops) return false;
  if (definition.on === 'node.created' && event.type !== 'node.created') return false;
  if (definition.on === 'bookmark.intake' && !['node.created', 'bookmark.intake'].includes(event.type)) return false;
  const scope = definition.scope.folderRole ? resolutions[definition.scope.folderRole] : undefined;
  if (scope?.status === 'valid') {
    const refs = definition.scope.includeDescendants ? [event.bookmark.parent, ...(event.bookmark.ancestors ?? [])] : [event.bookmark.parent];
    if (!refs.some((ref) => ref && sameFolder(ref, scope.snapshot.folder))) return false;
  }
  return true;
}
/** Labels/content revisions do not change placement authority; ancestry and policy do. */
export function bindingResolutionSignature(resolutions: Record<string, FolderResolution>) {
  return Object.fromEntries(Object.entries(resolutions).map(([role, resolution]) => {
    const snapshot = resolution.snapshot;
    const signature = snapshot
      ? { folder: snapshot.folder, ancestors: snapshot.ancestors, policy: snapshot.policyRevision } : undefined;
    return [role, resolution.status === 'valid' ? signature
      : { status: resolution.status, code: resolution.code, message: resolution.message, ...(signature ? { snapshot: signature } : {}) }];
  }));
}
