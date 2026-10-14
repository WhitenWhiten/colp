import {
  AUTOMATION_PROFILE, arbitratePlacement, automationDigest, compilePredicate, intakeRoleKeys, preparePredicateInput,
  ruleSemanticDigest, validateAutomation, validateM1Rule,
  type CompiledRule, type EventFacts, type FolderRef, type PlacementCandidate, type PlacementIntent, type RuleBundle,
  type RuleDefinition,
} from '@know-n/colp/automation';

/**
 * The browser-bounded rule profile (packages/node/docs/AUTOMATION_BROWSER_PROFILE.md).
 *
 * A bundle is installed whole or not at all. Every rule must be a deterministic
 * M1 intake rule whose complete `definition` this build evaluates with the shared
 * core; `programId`/`parameters` are hints and are never read. The extension
 * keeps only the glue the server keeps around the same core calls (scope,
 * eligibility, binding availability), so a device and the server arbitrate the
 * same competitor set the same way.
 */
export const BROWSER_PROFILE = AUTOMATION_PROFILE;

export type BundleRejection = 'invalid' | 'profile' | 'digest' | 'expired' | 'unsupported';
export type BundleCheck = { readonly ok: true; readonly bundle: RuleBundle; readonly serverUuid: string | null }
  | { readonly ok: false; readonly reason: BundleRejection };

const sameRef = (a: FolderRef, b: FolderRef) => a.serverUuid === b.serverUuid && a.collectionId === b.collectionId && a.nodeId === b.nodeId;

/** Every folder a rule binds, in role order. */
export function ruleFolders(rule: CompiledRule): FolderRef[] {
  const folders: FolderRef[] = [];
  for (const binding of Object.values(rule.nativeBindingHints)) {
    if (binding.kind === 'folder') folders.push(binding.folder, ...(binding.allowedAncestor ? [binding.allowedAncestor] : []));
  }
  return folders;
}

/** The collection a rule applies to: explicit scope, else the scope folder's collection (server `scopeCollectionId`). */
export function ruleCollectionId(rule: CompiledRule): string | undefined {
  const binding = rule.nativeBindingHints[rule.definition.scope.folderRole ?? ''];
  return rule.definition.scope.collectionId ?? (binding?.kind === 'folder' ? binding.folder.collectionId : undefined);
}

/** True when this build can evaluate the rule exactly as the server compiled it. */
export function ruleSupported(rule: CompiledRule): boolean {
  const definition = rule.definition;
  if (validateM1Rule(definition).length || !definition.intake) return false;
  try { if (ruleSemanticDigest(definition) !== rule.semanticDigest) return false; } catch { return false; }
  const roles = new Map(definition.roles.map((role) => [role.key, role]));
  for (const [key, binding] of Object.entries(rule.nativeBindingHints)) {
    if (binding.kind !== 'folder' || roles.get(key)?.kind !== 'folder') return false;
  }
  const intake = rule.nativeBindingHints[definition.intake.folderRole];
  return intake?.kind === 'folder' && ruleCollectionId(rule) !== undefined;
}

/** Shape, profile, digest, expiry and rule support. Monotonic ordering is the store's job. */
export function checkBundle(value: unknown, now: number): BundleCheck {
  if (!validateAutomation('RuleBundle', value).valid) return { ok: false, reason: 'invalid' };
  const bundle = value as RuleBundle;
  if (bundle.profile !== BROWSER_PROFILE) return { ok: false, reason: 'profile' };
  const { digest, ...content } = bundle;
  try { if (automationDigest(content) !== digest) return { ok: false, reason: 'digest' }; } catch { return { ok: false, reason: 'invalid' }; }
  const issued = Date.parse(bundle.issuedAt), expires = Date.parse(bundle.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return { ok: false, reason: 'invalid' };
  if (expires <= now) return { ok: false, reason: 'expired' };
  // A paused snapshot carries no rules; one rule per id.
  if ((bundle.paused && bundle.rules.length) || new Set(bundle.rules.map((rule) => rule.ruleId)).size !== bundle.rules.length) {
    return { ok: false, reason: 'invalid' };
  }
  if (!bundle.rules.every(ruleSupported)) return { ok: false, reason: 'unsupported' };
  const servers = new Set(bundle.rules.flatMap((rule) => ruleFolders(rule).map((folder) => folder.serverUuid)));
  if (servers.size > 1) return { ok: false, reason: 'invalid' };
  return { ok: true, bundle, serverUuid: servers.values().next().value ?? null };
}

/** A rule's folder roles resolved on this device. Unresolved roles never fall back to a path or a title. */
export type LocalFolder = { readonly status: 'resolved'; readonly folder: FolderRef; readonly nativeId: string; readonly title: string }
  | { readonly status: 'unresolved'; readonly folder: FolderRef; readonly reason: 'otherCollection' | 'unmapped' | 'deleted' | 'notFolder' };
export interface LocalRule {
  readonly rule: CompiledRule;
  readonly folders: Readonly<Record<string, LocalFolder>>;
}

export type LocalPlacement =
  | { readonly kind: 'none' }
  | { readonly kind: 'place'; readonly ruleId: string; readonly ruleIds: readonly string[]; readonly folder: LocalFolder & { readonly status: 'resolved' };
    readonly satisfies: readonly 'classify.root'[] }
  | { readonly kind: 'keep'; readonly ruleIds: readonly string[] }
  | { readonly kind: 'blocked'; readonly ruleIds: readonly string[]; readonly reason: 'bindingUnavailable' | 'evaluation' }
  | { readonly kind: 'conflict'; readonly ruleIds: readonly string[] }
  | { readonly kind: 'review'; readonly ruleIds: readonly string[] };

/** Server `eventEligible`: source policy, trigger and scope folder, before the predicate runs. */
function eligible(definition: RuleDefinition, folders: LocalRule['folders'], facts: EventFacts): boolean {
  if (facts.origin === 'restore' || (facts.origin === 'automation' && facts.stageId === 'intake' && definition.on !== 'intake.completed')
    || (facts.origin === 'import' && definition.policy.imports === 'exclude') || facts.hopCount >= definition.policy.maxHops) return false;
  if (definition.on === 'node.created' && facts.type !== 'node.created') return false;
  if (definition.on === 'bookmark.intake' && !['node.created', 'bookmark.intake'].includes(facts.type)) return false;
  const scope = definition.scope.folderRole ? folders[definition.scope.folderRole] : undefined;
  if (scope?.status === 'resolved') {
    const refs = definition.scope.includeDescendants ? [facts.bookmark.parent, ...(facts.bookmark.ancestors ?? [])] : [facts.bookmark.parent];
    if (!refs.some((ref) => ref && sameRef(ref, scope.folder))) return false;
  }
  return true;
}

/**
 * One normalization, one predicate call per eligible rule, one arbitration
 * (server `evaluateRuleEvents`). The intent is the caller's evidence of an
 * explicit choice; this never decides it.
 */
export function evaluateLocalRules(rules: readonly LocalRule[], facts: EventFacts, intent: PlacementIntent): LocalPlacement {
  if (!rules.length) return { kind: 'none' };
  const input = preparePredicateInput(facts);
  const candidates: PlacementCandidate[] = [], blocked: string[] = [], evaluation: string[] = [];
  const destinations = new Map<string, LocalFolder & { status: 'resolved' }>();
  for (const { rule, folders } of rules) {
    const definition = rule.definition;
    if (!definition.intake || !eligible(definition, folders, facts)) continue;
    const predicate = compilePredicate(definition.match);
    if (!predicate.valid) { evaluation.push(rule.ruleId); continue; }
    const outcome = predicate.evaluate(facts, { inputSnapshot: input }).outcome;
    if (outcome === 'error') { evaluation.push(rule.ruleId); continue; }
    if (outcome !== 'matched') continue;
    const destination = folders[definition.intake.folderRole];
    if ([...intakeRoleKeys(definition)].some((key) => folders[key]?.status !== 'resolved') || destination?.status !== 'resolved') {
      blocked.push(rule.ruleId); continue;
    }
    destinations.set(rule.ruleId, destination);
    candidates.push({ ruleId: rule.ruleId, priority: definition.priority, folder: destination.folder, authorized: true, privacyAllowed: true });
  }
  if (!candidates.length) {
    if (evaluation.length) return { kind: 'blocked', ruleIds: evaluation.sort(), reason: 'evaluation' };
    return blocked.length ? { kind: 'blocked', ruleIds: blocked.sort(), reason: 'bindingUnavailable' } : { kind: 'none' };
  }
  const decision = arbitratePlacement(candidates, intent);
  switch (decision.kind) {
    case 'place': {
      const ruleId = decision.ruleIds[0]!, rule = rules.find((item) => item.rule.ruleId === ruleId)!.rule;
      return { kind: 'place', ruleId, ruleIds: decision.ruleIds, folder: destinations.get(ruleId)!,
        satisfies: [...rule.definition.intake!.satisfies] };
    }
    case 'conflict': return { kind: 'conflict', ruleIds: decision.ruleIds };
    case 'keepParent': return { kind: 'keep', ruleIds: decision.ruleIds };
    case 'blocked': return { kind: 'blocked', ruleIds: decision.ruleIds, reason: 'bindingUnavailable' };
    case 'review': return { kind: 'review', ruleIds: decision.ruleIds };
  }
}
