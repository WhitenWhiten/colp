import type { EventFacts, Predicate, FieldPredicate } from './types.generated.js';
import { normalizeEventFacts } from './normalize.js';
import { prepareAutomationSchema } from './schema.js';
import { preparedPredicateInput, type PreparedPredicateInput } from './predicate-input.js';

export type PredicateDecision = { outcome: 'matched' | 'notMatched' | 'missingInput' } | { outcome: 'error'; code: 'evaluationBudgetExceeded' | 'evaluationFailed' };
export interface EvaluationOptions { now?: () => number; budgetMs?: number; factsVersion?: number; inputSnapshot?: PreparedPredicateInput }
function readField(facts: EventFacts, field: FieldPredicate['field']): string | string[] | undefined {
  switch (field) {
    case 'bookmark.url.host': return facts.bookmark.url.host || undefined;
    case 'bookmark.url.path': return facts.bookmark.url.path;
    case 'bookmark.title': return facts.bookmark.title;
    case 'bookmark.tags': return facts.bookmark.tags;
    case 'bookmark.kind': return facts.bookmark.kind;
    case 'event.type': return facts.type;
    case 'event.origin': return facts.origin;
    case 'event.changedFields': return facts.changedFields;
  }
}

export function evaluatePredicate(predicate: Predicate, value: unknown, options: EvaluationOptions = {}): PredicateDecision {
  prepareAutomationSchema('EventFacts');
  const now = options.now ?? (() => performance.now());
  const started = now();
  const budget = Math.min(options.budgetMs ?? 50, 50);
  const snapshot = options.inputSnapshot ? preparedPredicateInput(options.inputSnapshot, value, options.factsVersion) : undefined;
  if (options.inputSnapshot && !snapshot) return { outcome: 'error', code: 'evaluationFailed' };
  const normalized = snapshot?.normalized ?? normalizeEventFacts(value, options.factsVersion);
  const elapsed = () => now() - started + (snapshot?.preparationMs ?? 0);
  // Input validation and normalization consume the deadline even when their
  // immutable result is reused. Trusted schema compilation is prepared separately.
  if (elapsed() > budget) return { outcome: 'error', code: 'evaluationBudgetExceeded' };
  if (normalized.status !== 'available') return { outcome: 'missingInput' };
  let visited = 0;
  const visit = (node: Predicate, depth: number): PredicateDecision => {
    if (++visited > 128 || depth > 16 || elapsed() > budget) return { outcome: 'error', code: 'evaluationBudgetExceeded' };
    if (node.kind === 'cel') return { outcome: 'error', code: 'evaluationFailed' };
    if (node.kind === 'not') {
      const result = visit(node.item, depth + 1);
      return result.outcome === 'matched' ? { outcome: 'notMatched' }
        : result.outcome === 'notMatched' ? { outcome: 'matched' } : result;
    }
    if (node.kind === 'all' || node.kind === 'any') {
      const children = node.items.map((item) => visit(item, depth + 1));
      const error = children.find((result) => result.outcome === 'error');
      if (error) return error;
      const decisive = node.kind === 'all' ? 'notMatched' : 'matched';
      if (children.some((result) => result.outcome === decisive)) return { outcome: decisive };
      if (children.some((result) => result.outcome === 'missingInput')) return { outcome: 'missingInput' };
      return { outcome: node.kind === 'all' ? 'matched' : 'notMatched' };
    }
    const field = readField(normalized.facts, node.field);
    if (field === undefined) return { outcome: 'missingInput' };
    const expected = node.value;
    let matches = false;
    switch (node.op) {
      case 'eq': matches = field === expected; break;
      case 'in': matches = Array.isArray(expected) && typeof field === 'string' && expected.includes(field); break;
      case 'contains': matches = typeof field === 'string' && typeof expected === 'string' && field.includes(expected); break;
      case 'startsWith': matches = typeof field === 'string' && typeof expected === 'string' && field.startsWith(expected); break;
      case 'hostSuffix': matches = typeof field === 'string' && typeof expected === 'string' && (field === expected || field.endsWith(`.${expected}`)); break;
      case 'hasTag': matches = Array.isArray(field) && typeof expected === 'string' && field.includes(expected); break;
    }
    return { outcome: matches ? 'matched' : 'notMatched' };
  };
  try { return visit(predicate, 1); } catch { return { outcome: 'error', code: 'evaluationFailed' }; }
}
