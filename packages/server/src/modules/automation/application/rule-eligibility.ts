import { intakeRoleKeys, type EventFacts, type RuleDefinition } from '@know-n/colp/automation';
import { sameFolder, type FolderResolution } from '../domain/bindings.js';

export interface BindingIssue {
  role: string;
  resolution: Extract<FolderResolution, { status: 'blocked' }>;
  severity: 'error' | 'warning';
  blockingStages: string[];
}
export interface BindingAssessment { available: boolean; issues: BindingIssue[] }

/** A required role is required by its consumers; an unused role cannot block this stage. */
export function assessIntakeBindings(definition: RuleDefinition, resolutions: Record<string, FolderResolution>): BindingAssessment {
  const used = intakeRoleKeys(definition);
  const issues: BindingIssue[] = [];
  for (const role of definition.roles) {
    const resolution = resolutions[role.key];
    if (resolution?.status === 'valid' || (!resolution && !role.required && !used.has(role.key))) continue;
    const blocking = used.has(role.key);
    issues.push({ role: role.key, resolution: resolution ?? {
      status: 'blocked', code: 'bindingDeleted', message: 'Choose a live authorized folder for this role.',
    }, severity: blocking ? 'error' : 'warning', blockingStages: blocking ? ['intake'] : [] });
  }
  return { available: !issues.some((issue) => issue.blockingStages.length > 0), issues };
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
