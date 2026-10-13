import { analyzeRoleGraph, type RuleDefinition, type RoleBindings } from '@know-n/colp/automation';
import { sameFolder, scopeCollectionId, type AutomationActor, type BindingReadPort, type FolderResolution } from '../domain/bindings.js';

export async function resolveBindings(reads: BindingReadPort, actor: AutomationActor, definition: RuleDefinition, values: RoleBindings): Promise<Record<string, FolderResolution>> {
  const results: Record<string, FolderResolution> = {};
  const graph = analyzeRoleGraph(definition.roles);
  if (!graph.valid) return Object.fromEntries(definition.roles.map((role) => [role.key, {
    status: 'blocked', code: 'scopeChanged', message: 'Role constraints must be an acyclic graph of declared folder roles.',
  }]));
  const scope = scopeCollectionId(definition, values);
  for (const role of graph.order) {
    const binding = values[role.key];
    if (!binding) {
      if (role.required || definition.intake?.folderRole === role.key || definition.scope.folderRole === role.key)
        results[role.key] = { status: 'blocked', code: 'bindingDeleted', message: 'Choose a live authorized folder for this role.' };
      continue;
    }
    if (binding.kind !== 'folder' || role.kind !== 'folder' || binding.folder.collectionId !== scope) {
      results[role.key] = { status: 'blocked', code: 'scopeChanged', message: 'Folder binding must have the declared kind and belong to the scoped collection.' }; continue;
    }
    const result = await reads.readFolder(actor, binding.folder);
    results[role.key] = result;
    const allowedAncestor = binding.allowedAncestor;
    if (result.status === 'valid' && allowedAncestor) {
      const ancestor = await reads.readFolder(actor, allowedAncestor);
      if (ancestor.status !== 'valid' || (!sameFolder(result.snapshot.folder, allowedAncestor)
        && !result.snapshot.ancestors.some((ref) => sameFolder(ref, allowedAncestor))))
        results[role.key] = { status: 'blocked', code: 'scopeChanged', snapshot: result.snapshot,
          message: 'Folder is outside its allowed ancestor. Choose another folder or restore its location.' };
    }
  }
  for (const role of graph.order) {
    if (!role.mustBeWithinRole) continue;
    const child = results[role.key], parent = results[role.mustBeWithinRole];
    if (child?.status === 'valid' && (parent?.status !== 'valid' || (!sameFolder(child.snapshot.folder, parent.snapshot.folder)
      && !child.snapshot.ancestors.some((ref) => sameFolder(ref, parent.snapshot.folder)))))
      results[role.key] = { status: 'blocked', code: 'scopeChanged', snapshot: child.snapshot, message: 'Folder is outside the required role subtree.' };
  }
  return results;
}
