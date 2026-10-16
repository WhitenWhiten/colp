import type {
  AutomationBindingSet,
  AutomationBindingSetInput,
  AutomationFieldPredicate,
  AutomationFolderRef,
  AutomationPredicate,
  AutomationRule,
  AutomationRuleDefinition,
  AutomationRuleInput,
} from '../../api/automationTypes'

/* The form the editor shows, and its exact translation to and from the
   reviewed rule contract (m1-rule-create.json). The form covers the M1
   placement rule: finite conditions, one destination folder, no agent tasks.
   A definition the form cannot show round-trips through Advanced (JSON)
   untouched; nothing here guesses at a rule's meaning. */

export type ConditionKind = 'siteIs' | 'siteEndsWith' | 'titleContains' | 'hasTag' | 'pathStartsWith'

export type DraftCondition = { key: string; kind: ConditionKind; value: string }

export type RuleDraft = {
  name: string
  conditions: DraftCondition[]
  combinator: 'all' | 'any'
  collectionId: string
  /** The destination folder (a node id inside collectionId). */
  folderId: string
  priority: number
  maxRunsPerDay: number
}

/** The one folder role the form manages. */
export const DESTINATION_ROLE = 'destination'

const FIELD_BY_KIND: Record<ConditionKind, Pick<AutomationFieldPredicate, 'field' | 'op'>> = {
  siteIs: { field: 'bookmark.url.host', op: 'eq' },
  siteEndsWith: { field: 'bookmark.url.host', op: 'hostSuffix' },
  titleContains: { field: 'bookmark.title', op: 'contains' },
  hasTag: { field: 'bookmark.tags', op: 'hasTag' },
  pathStartsWith: { field: 'bookmark.url.path', op: 'startsWith' },
}

export const DEFAULT_PRIORITY = 100
export const DEFAULT_MAX_RUNS_PER_DAY = 100

let conditionSeq = 0
export function newConditionKey(): string {
  conditionSeq += 1
  return `condition-${conditionSeq}`
}

export function emptyDraft(collectionId = '', folderId = ''): RuleDraft {
  return {
    name: '',
    conditions: [{ key: newConditionKey(), kind: 'siteIs', value: '' }],
    combinator: 'all',
    collectionId,
    folderId,
    priority: DEFAULT_PRIORITY,
    maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
  }
}

const CONDITION_KINDS = Object.keys(FIELD_BY_KIND) as ConditionKind[]
const ADDRESS_CONDITIONS = 8
const ADDRESS_VALUE = 512

/** One `condition=kind:value` from the address; anything the form cannot show is dropped. */
function conditionFromAddress(raw: string): DraftCondition | null {
  const at = raw.indexOf(':')
  const kind = raw.slice(0, at) as ConditionKind
  const value = raw.slice(at + 1).trim()
  if (at < 1 || !CONDITION_KINDS.includes(kind) || !value || value.length > ADDRESS_VALUE) return null
  return { key: newConditionKey(), kind, value }
}

/**
 * A new rule filled in from the address: `collectionId` and `folderId` (Automate… on a folder), and, from a
 * rule the extension keeps in one browser (AW-70), `name`, `combinator` and repeated `condition=kind:value`.
 * It is only a form: nothing is created until the Owner saves, and turning it on still needs a preview.
 */
export function draftFromSearch(search: URLSearchParams): RuleDraft {
  const draft = emptyDraft(search.get('collectionId') ?? '', search.get('folderId') ?? '')
  const conditions = search.getAll('condition').map(conditionFromAddress).filter((item): item is DraftCondition => item !== null)
    .slice(0, ADDRESS_CONDITIONS)
  return {
    ...draft,
    name: (search.get('name') ?? '').trim().slice(0, 200),
    combinator: search.get('combinator') === 'any' ? 'any' : 'all',
    ...(conditions.length ? { conditions } : {}),
  }
}

export function conditionKindOf(predicate: AutomationPredicate): ConditionKind | null {
  if (predicate.kind !== 'field' || typeof predicate.value !== 'string') return null
  for (const [kind, shape] of Object.entries(FIELD_BY_KIND) as [ConditionKind, typeof FIELD_BY_KIND[ConditionKind]][]) {
    if (shape.field === predicate.field && shape.op === predicate.op) return kind
  }
  return null
}

function conditionPredicate(condition: DraftCondition): AutomationFieldPredicate {
  return { kind: 'field', ...FIELD_BY_KIND[condition.kind], value: condition.value.trim() }
}

/** Conditions with a value; an empty row is a row the owner has not filled in yet. */
export function filledConditions(draft: RuleDraft): DraftCondition[] {
  return draft.conditions.filter((condition) => condition.value.trim() !== '')
}

export function draftMatch(draft: RuleDraft): AutomationPredicate {
  const items = filledConditions(draft).map(conditionPredicate)
  const [only] = items
  if (items.length === 1 && only) return only
  return { kind: draft.combinator, items }
}

export type DraftProblem = { field: 'conditions' | 'folder' | 'name'; message: string }

/** What the owner still has to fill in; shape only, the server validates meaning. */
export function draftProblems(draft: RuleDraft): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (filledConditions(draft).length === 0) problems.push({ field: 'conditions', message: 'Add at least one condition.' })
  if (!draft.collectionId || !draft.folderId) problems.push({ field: 'folder', message: 'Choose the folder bookmarks go to.' })
  if (draft.name.trim().length > 200) problems.push({ field: 'name', message: 'Use 200 characters or fewer.' })
  return problems
}

/** The reviewed M1 placement definition (no agent, no execution policy). */
export function draftDefinition(draft: RuleDraft, fallbackName: string, base?: AutomationRuleDefinition): AutomationRuleDefinition {
  const name = draft.name.trim() || fallbackName
  const policy = base?.policy ?? {
    history: 'fromActivation',
    imports: 'exclude',
    restores: 'exclude',
    userEdits: 'preserve',
    sameStageReentry: 'deny',
    maxHops: 8,
    conflictingPlacement: 'review',
    privacy: 'standard',
    broadcastAllowed: false,
    maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
    pauseMode: 'stopAdmissionHoldPending',
    missingInput: 'defer',
  }
  return {
    apiVersion: 'colp.automation/v1',
    ...base,
    name,
    roles: base?.roles ?? [
      { key: DESTINATION_ROLE, kind: 'folder', required: true, description: 'Folder matching bookmarks are moved to' },
    ],
    on: base?.on ?? 'bookmark.intake',
    scope: { ...base?.scope, collectionId: draft.collectionId },
    match: draftMatch(draft),
    intake: base?.intake ?? {
      folderRole: DESTINATION_ROLE,
      constraint: 'withinSubtree',
      satisfies: ['classify.root'],
      onUnusableBinding: 'keepOriginalAndBlock',
      respectExplicitSelection: true,
    },
    trigger: base?.trigger ?? { mode: 'each' },
    tasks: base?.tasks ?? [],
    route: base?.route ?? { mode: 'targets', targetIds: [], execution: 'single' },
    policy: { ...policy, maxRunsPerDay: draft.maxRunsPerDay },
    priority: draft.priority,
  }
}

export function bindingInput(name: string, folder: AutomationFolderRef, role = DESTINATION_ROLE): AutomationBindingSetInput {
  return {
    name: name.slice(0, 200),
    values: {
      [role]: {
        kind: 'folder',
        folder,
        followIdentity: true,
        onUnavailable: 'block',
        notifyOn: ['rename', 'move', 'delete', 'permission', 'syncScope'],
      },
    },
  }
}

/** The intake folder a rule's binding set resolves its destination role to. */
export function destinationFolder(definition: AutomationRuleDefinition, binding: AutomationBindingSet | undefined): AutomationFolderRef | null {
  const role = definition.intake?.folderRole
  if (!role || !binding) return null
  const value = binding.values[role]
  return value?.kind === 'folder' ? value.folder : null
}

/** The form for a definition and its destination folder, or null when the definition goes beyond what the form shows. */
export function draftFromDefinition(
  definition: AutomationRuleDefinition,
  folder: Pick<AutomationFolderRef, 'collectionId' | 'nodeId'> | null,
): RuleDraft | null {
  if (definition.tasks.length > 0 || definition.trigger.mode !== 'each' || definition.on !== 'bookmark.intake') return null
  if (!definition.intake || definition.roles.length !== 1 || definition.scope.folderRole || definition.scope.includeDescendants !== undefined) return null
  const collectionId = definition.scope.collectionId
  if (!folder || !collectionId || folder.collectionId !== collectionId) return null
  const match = definition.match
  const parts = match.kind === 'all' || match.kind === 'any' ? match.items : [match]
  const conditions: DraftCondition[] = []
  for (const part of parts) {
    const kind = conditionKindOf(part)
    if (!kind || part.kind !== 'field' || typeof part.value !== 'string') return null
    conditions.push({ key: newConditionKey(), kind, value: part.value })
  }
  if (conditions.length === 0) return null
  const draft: RuleDraft = {
    name: definition.name,
    conditions,
    combinator: match.kind === 'any' ? 'any' : 'all',
    collectionId,
    folderId: folder.nodeId,
    priority: definition.priority,
    maxRunsPerDay: definition.policy.maxRunsPerDay,
  }
  // Only use the form when it can round-trip the complete definition exactly.
  return definitionKey(draftDefinition(draft, definition.name, definition)) === definitionKey(definition) ? draft : null
}

function definitionKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

/** The form for a stored rule, or null when its definition goes beyond what the form shows. */
export function draftFromRule(rule: AutomationRule, binding: AutomationBindingSet | undefined): RuleDraft | null {
  return draftFromDefinition(rule.definition, destinationFolder(rule.definition, binding))
}

/** Stable identity of what a preview evaluated; any edit changes it. */
export function configurationKey(definition: AutomationRuleDefinition, bindingKey: string): string {
  return JSON.stringify([definition, bindingKey])
}

/** Preserve metadata the definition form does not own in every editor request. */
export function ruleInput(definition: AutomationRuleDefinition, bindingSetId: string, base: AutomationRule | null, executionPolicyId: string | null | undefined = base?.executionPolicyId): AutomationRuleInput {
  return { definition, bindingSetId,
    ...(executionPolicyId ? { executionPolicyId } : {}),
    ...(base?.templateRef ? { templateRef: base.templateRef } : {}),
  }
}
