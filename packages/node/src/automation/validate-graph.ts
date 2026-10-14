import type { RuleDefinition } from './types.generated.js';
import { TASK_OUTPUT_CONTRACTS } from './task-contracts.js';
import { validateAutomation, type ContractIssue } from './schema.js';
import { compilePredicate } from './compile.js';
import { analyzeRoleGraph } from './role-graph.js';

export function validateTaskGraph(definition: RuleDefinition): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ path, code: 'invalidGraph', message });
  const roles = new Map(definition.roles.map((role) => [role.key, role]));
  const tasks = new Map(definition.tasks.map((task) => [task.id, task]));
  const roleGraph = analyzeRoleGraph(definition.roles);
  if (!roleGraph.valid) issues.push(...roleGraph.issues);
  if (tasks.size !== definition.tasks.length || tasks.size > 8) fail('/tasks', 'Task IDs must be unique; maximum eight tasks.');
  const requireRole = (key: string | undefined, kind: string, path: string) => {
    if (key !== undefined && roles.get(key)?.kind !== kind) fail(path, `Expected declared ${kind} role.`);
  };
  requireRole(definition.scope.folderRole, 'folder', '/scope/folderRole');
  if (definition.intake) {
    requireRole(definition.intake.folderRole, 'folder', '/intake/folderRole');
    if (definition.on !== 'bookmark.intake' || definition.trigger.mode !== 'each') fail('/intake', 'Intake requires bookmark.intake and each.');
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { fail('/tasks', 'Task graph contains a cycle.'); return; }
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) { fail('/tasks', `Unknown predecessor ${id}.`); return; }
    visiting.add(id);
    task.after.forEach(visit);
    visiting.delete(id); visited.add(id);
  };
  for (const task of definition.tasks) {
    if (task.after.length > 8 || new Set(task.after).size !== task.after.length) fail(`/tasks/${task.id}/after`, 'Predecessors must be unique and bounded.');
    requireRole(task.executorRole, 'executor', `/tasks/${task.id}/executorRole`);
    requireRole(task.folderRole, 'folder', `/tasks/${task.id}/folderRole`);
    requireRole(task.entityMapRole, 'entityMap', `/tasks/${task.id}/entityMapRole`);
    requireRole(task.vocabularyRole, 'vocabulary', `/tasks/${task.id}/vocabularyRole`);
    if (!TASK_OUTPUT_CONTRACTS[task.type]?.includes(task.outputContract)) fail(`/tasks/${task.id}/outputContract`, 'Unsupported output contract for task type.');
    visit(task.id);
  }
  return issues;
}

export function validateM1Rule(value: unknown): ContractIssue[] {
  const shape = validateAutomation('RuleDefinition', value);
  if (!shape.valid) return shape.issues;
  const rule = value as RuleDefinition;
  const issues = validateTaskGraph(rule);
  const compiled = compilePredicate(rule.match);
  if (!compiled.valid) issues.push(...compiled.issues);
  if (rule.tasks.length || rule.route.mode !== 'targets' || (rule.route.targetIds?.length ?? 0) || rule.route.execution !== 'single'
    || rule.trigger.mode !== 'each' || !['bookmark.intake', 'node.created'].includes(rule.on)
    || rule.roles.some((role) => role.kind !== 'folder') || rule.policy.broadcastAllowed) {
    issues.push({ path: '', code: 'unsupportedCapability', message: 'Only deterministic M1 each rules are available; no worker, model, broadcast or batch runtime.' });
  }
  return issues;
}
