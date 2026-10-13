import { validateAutomation, type ContractIssue } from './schema.js';
import { normalizeHost } from './normalize.js';
import { evaluatePredicate, type PredicateDecision, type EvaluationOptions } from './predicate.js';
import type { Predicate, RuleDefinition } from './types.generated.js';

export type CompiledPredicate = { valid: true; normalizedPredicate: Predicate; dependencies: string[]; evaluate: (facts: unknown, options?: EvaluationOptions) => PredicateDecision }
  | { valid: false; issues: ContractIssue[] };
export function compilePredicate(value: unknown): CompiledPredicate {
  const shape = validateAutomation('Predicate', value);
  if (!shape.valid) return shape;
  const predicate = structuredClone(value) as Predicate;
  const issues: ContractIssue[] = [];
  const dependencies = new Set<string>();
  let count = 0;
  const issue = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const walk = (node: Predicate, depth: number, path: string): void => {
    if (++count > 128 || depth > 16) { issue(path, 'predicateLimit', 'Maximum 16 levels and 128 nodes.'); return; }
    if (node.kind === 'cel') { issue(path, 'unsupportedCapability', 'CEL is not mounted on this host.'); return; }
    if (node.kind === 'not') return walk(node.item, depth + 1, `${path}/item`);
    if (node.kind === 'all' || node.kind === 'any') {
      if (!node.items.length) issue(path, 'emptyOperands', 'Boolean operands must not be empty.');
      node.items.forEach((item, index) => walk(item, depth + 1, `${path}/items/${index}`)); return;
    }
    dependencies.add(node.field);
    const arrayField = ['bookmark.tags', 'event.changedFields'].includes(node.field);
    if ((node.op === 'in') !== Array.isArray(node.value)) issue(path, 'operatorType', 'Only in accepts an array value.');
    if (arrayField && !(node.op === 'hasTag' && node.field === 'bookmark.tags')) issue(path, 'operatorType', 'Array fields require a compatible array operator.');
    if (node.op === 'hasTag' && node.field !== 'bookmark.tags') issue(path, 'operatorType', 'hasTag requires bookmark.tags.');
    if (node.op === 'startsWith' && node.field !== 'bookmark.url.path') issue(path, 'operatorType', 'startsWith requires bookmark.url.path.');
    if (node.op === 'hostSuffix' && node.field !== 'bookmark.url.host') issue(path, 'operatorType', 'hostSuffix requires bookmark.url.host.');
    if (node.field === 'bookmark.url.host' && ['eq', 'in', 'hostSuffix'].includes(node.op)) {
      const values = Array.isArray(node.value) ? node.value : [node.value];
      const hosts = values.map(normalizeHost);
      if (hosts.some((host) => host === undefined)) issue(path, 'invalidHost', 'Expected a domain, without URL delimiters.');
      else node.value = Array.isArray(node.value) ? hosts as string[] : hosts[0]!;
    } else if (typeof node.value === 'string') node.value = node.value.normalize('NFC');
    else node.value = node.value.map((value) => value.normalize('NFC'));
  };
  walk(predicate, 1, '/match');
  if (issues.length) return { valid: false, issues: issues.slice(0, 100) };
  return { valid: true, normalizedPredicate: structuredClone(predicate), dependencies: [...dependencies].sort(), evaluate: (facts, options) => evaluatePredicate(predicate, facts, options) };
}

/** Uses exactly the evaluator's normalization; never mutates the caller's definition. */
export function normalizeRuleDefinition(definition: RuleDefinition): RuleDefinition {
  const normalized = structuredClone(definition);
  const compiled = compilePredicate(normalized.match);
  if (compiled.valid) normalized.match = compiled.normalizedPredicate;
  return normalized;
}
