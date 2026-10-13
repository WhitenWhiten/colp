import type { RoleDeclaration, RuleDefinition } from './types.generated.js';
import type { ContractIssue } from './schema.js';

export type RoleGraph = { valid: true; order: RoleDeclaration[] } | { valid: false; issues: ContractIssue[] };

/** Parent roles precede their dependents. Self references and cycles are invalid constraints. */
export function analyzeRoleGraph(declarations: readonly RoleDeclaration[]): RoleGraph {
  const roles = new Map(declarations.map((role) => [role.key, role]));
  const issues: ContractIssue[] = [], order: RoleDeclaration[] = [];
  const visited = new Set<string>(), visiting = new Set<string>();
  const fail = (key: string, message: string) => issues.push({ path: `/roles/${key}/mustBeWithinRole`, code: 'invalidGraph', message });
  if (roles.size !== declarations.length) fail('', 'Role keys must be unique.');
  const visit = (role: RoleDeclaration): void => {
    if (visited.has(role.key)) return;
    if (visiting.has(role.key)) { fail(role.key, 'Role constraints contain a cycle.'); return; }
    visiting.add(role.key);
    if (role.mustBeWithinRole !== undefined) {
      const parent = roles.get(role.mustBeWithinRole);
      if (role.kind !== 'folder' || parent?.kind !== 'folder') fail(role.key, 'Subtree constraints require two declared folder roles.');
      else visit(parent);
    }
    visiting.delete(role.key);
    visited.add(role.key);
    order.push(role);
  };
  [...roles.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).forEach(visit);
  return issues.length ? { valid: false, issues } : { valid: true, order };
}

/** Stage dependencies include all transitive constraints, irrespective of declaration order. */
export function intakeRoleKeys(definition: RuleDefinition): Set<string> {
  const roles = new Map(definition.roles.map((role) => [role.key, role]));
  const used = new Set([definition.scope.folderRole, definition.intake?.folderRole].filter((key): key is string => key !== undefined));
  for (const key of used) {
    const ancestor = roles.get(key)?.mustBeWithinRole;
    if (ancestor !== undefined) used.add(ancestor);
  }
  return used;
}
