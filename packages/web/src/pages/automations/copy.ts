import type { IconName } from '../../components/Icon'
import type { StatusTone } from '../../components/StatusBadge'
import type {
  AutomationDependency,
  AutomationDiagnostic,
  AutomationHealthIncident,
  AutomationJob,
  AutomationPredicate,
  AutomationPreviewDecision,
  AutomationRule,
  AutomationRuleDefinition,
  AutomationRun,
} from '../../api/automationTypes'
import { conditionKindOf, type ConditionKind } from './ruleDraft'

/* Words for automation states and server explanations. Presentation only:
   every state and every decision comes from the backend DTO; a server
   sentence this table does not know is shown as the server wrote it. */

type ConditionOption = { kind: ConditionKind; label: string; placeholder: string; hint: string }

const SITE_IS: ConditionOption = { kind: 'siteIs', label: 'Site is', placeholder: 'arxiv.org', hint: 'The exact site, without https:// or a path.' }

export const CONDITION_OPTIONS: ReadonlyArray<ConditionOption> = [
  SITE_IS,
  { kind: 'siteEndsWith', label: 'Site ends with', placeholder: 'github.com', hint: 'Also matches its subdomains, such as gist.github.com.' },
  { kind: 'titleContains', label: 'Title contains', placeholder: 'Paper', hint: 'Matches these exact letters, capitals included.' },
  { kind: 'hasTag', label: 'Has tag', placeholder: 'research', hint: 'One tag, as you wrote it on the bookmark.' },
  { kind: 'pathStartsWith', label: 'Link path starts with', placeholder: '/papers/', hint: 'The part of the link after the site, starting with /.' },
]

export function conditionOption(kind: ConditionKind) {
  return CONDITION_OPTIONS.find((option) => option.kind === kind) ?? SITE_IS
}

/** A sentence part; terms are the owner's own values and get emphasis. */
export type SentencePart = { text: string; term?: boolean }

/** `many`: the subject is several bookmarks ("Every 5 bookmarks … that are from …"). */
function conditionParts(predicate: AutomationPredicate, many: boolean): SentencePart[] | null {
  const kind = conditionKindOf(predicate)
  if (!kind || predicate.kind !== 'field' || typeof predicate.value !== 'string') return null
  const value = predicate.value
  const is = many ? 'are' : 'is'
  const has = many ? 'have' : 'has'
  switch (kind) {
    case 'siteIs': return [{ text: `${is} from ` }, { text: value, term: true }]
    case 'siteEndsWith': return [{ text: `${is} from ` }, { text: value, term: true }, { text: ' or a subdomain' }]
    case 'titleContains': return [{ text: `${has} ` }, { text: `“${value}”`, term: true }, { text: many ? ' in their titles' : ' in its title' }]
    case 'hasTag': return [{ text: `${is} tagged ` }, { text: value, term: true }]
    case 'pathStartsWith': return [{ text: `${has} a link path starting with ` }, { text: value, term: true }]
  }
}

function matchParts(match: AutomationPredicate, many: boolean, draft: boolean): SentencePart[] {
  const fallback = [{ text: many ? 'match its conditions' : 'matches its conditions' }]
  const items = match.kind === 'all' || match.kind === 'any' ? match.items : [match]
  if (draft && items.length === 0) return [{ text: many ? 'match the conditions you add' : 'matches the conditions you add' }]
  const joiner = match.kind === 'any' ? ' or ' : ' and '
  const parts: SentencePart[] = []
  for (const [index, item] of items.entries()) {
    const described = conditionParts(item, many)
    if (!described) return fallback
    if (index > 0) parts.push({ text: joiner })
    parts.push(...described)
  }
  return parts.length > 0 ? parts : fallback
}

const TASK_PHRASES: Record<string, string> = {
  'classify.root': 'choose its folder',
  'classify.refine': 'pick a subfolder',
  'tags.generate': 'suggest tags',
  'summary.generate': 'write a summary',
  'metadata.resolve': 'fill in its details',
  'review.generate': 'write a review',
  'digest.generate': 'write a digest',
}

export function taskPhrase(type: string): string {
  return TASK_PHRASES[type] ?? type
}

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * "When a bookmark saved to Personal is from arxiv.org, move it to Academic."
 * Names are the current ones the page could read; a missing one says so,
 * and only the owner's own values are set as terms. `draft`: the editor's
 * rule, where a missing part is one the owner has not filled in yet.
 */
export function ruleSentence(
  definition: AutomationRuleDefinition,
  names: { collection: string | null; folder: string | null; folderGone?: boolean; draft?: boolean },
): SentencePart[] {
  const parts: SentencePart[] = []
  const trigger = definition.trigger
  const many = trigger.mode === 'countBatch'
  const draft = names.draft === true
  parts.push({ text: many ? `Every ${trigger.count} bookmarks saved to ` : 'When a bookmark saved to ' })
  parts.push({ text: names.collection ?? (draft ? 'the collection you choose' : 'its collection'), term: names.collection !== null })
  parts.push({ text: many ? ' that ' : ' ' })
  parts.push(...matchParts(definition.match, many, draft))
  if (definition.intake) {
    parts.push({ text: many ? ', move them to ' : ', move it to ' })
    if (names.folderGone) parts.push({ text: 'a folder that is gone' })
    else parts.push({ text: names.folder ?? (draft ? 'the folder you choose' : 'its folder'), term: names.folder !== null })
  }
  if (definition.tasks.length > 0) {
    parts.push({ text: definition.intake ? ', then ask an agent to ' : ', ask an agent to ' })
    parts.push({ text: listPhrase(definition.tasks.map((task) => taskPhrase(task.type))) })
  }
  parts.push({ text: '.' })
  return parts
}

export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.map((part) => part.text).join('')
}

/** A name the owner did not type: "arxiv.org → Academic". */
export function suggestedRuleName(firstValue: string, folderTitle: string | null): string {
  const value = firstValue.trim()
  if (value && folderTitle) return `${value} → ${folderTitle}`
  if (folderTitle) return `Into ${folderTitle}`
  return value || 'New rule'
}

export const RULE_STATE: Record<AutomationRule['effectiveState'], { label: string; tone: StatusTone }> = {
  draft: { label: 'Draft', tone: 'muted' },
  active: { label: 'On', tone: 'success' },
  degraded: { label: 'On, with problems', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
  paused: { label: 'Paused', tone: 'warning' },
  archived: { label: 'Archived', tone: 'muted' },
}

export const RUN_STATUS: Record<AutomationRun['status'], { label: string; tone: StatusTone }> = {
  waiting: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  review: { label: 'Needs a decision', tone: 'warning' },
  completed: { label: 'Done', tone: 'success' },
  partial: { label: 'Partly done', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
}

/** What each run state means for the owner, under its badge. */
export const RUN_STATUS_DETAIL: Record<AutomationRun['status'], string> = {
  waiting: 'Waiting to start. It goes on by itself once its work can run.',
  running: 'Running now.',
  review: 'Stopped for your decision. Nothing more happens until you change the rule or cancel this run.',
  completed: 'Finished.',
  partial: 'Partly finished. What was done is kept; the rest did not happen.',
  blocked: 'Blocked. It won’t go on until the problem is fixed.',
  cancelled: 'Cancelled. Anything already done stays.',
  failed: 'Failed. Nothing more will happen for this run.',
}

/** A run page's title: short, so the server's explanation can say the rest. */
export const RUN_HEADLINE: Record<AutomationRun['status'], string> = {
  waiting: 'Run waiting to start',
  running: 'Run in progress',
  review: 'Run needs your decision',
  completed: 'Run finished',
  partial: 'Run partly finished',
  blocked: 'Run blocked',
  cancelled: 'Run cancelled',
  failed: 'Run failed',
}

/** Runs that still have work left to cancel; the server decides whether it can. */
export function runHasRemainingWork(status: AutomationRun['status']): boolean {
  return status === 'waiting' || status === 'running' || status === 'blocked' || status === 'review'
}

export const RULE_STATE_DETAIL: Record<AutomationRule['effectiveState'], string> = {
  draft: 'Not on yet. Preview it and turn it on to start filing bookmarks.',
  active: 'On. It files matching bookmarks as you save them.',
  degraded: 'On, with an issue to review. Check the notices below.',
  blocked: 'Stopped until the problem is fixed. Bookmarks are still saved where you put them.',
  paused: 'Paused. Bookmarks are saved as usual and this rule doesn’t file them. Preview it again to turn it back on.',
  archived: 'Archived. Its history stays; it can’t be turned on again.',
}

export const JOB_STATUS: Record<AutomationJob['status'], { label: string; tone: StatusTone; detail: string }> = {
  pending: { label: 'Waiting', tone: 'neutral', detail: 'Waiting for an earlier step or for what it needs.' },
  ready: { label: 'Ready', tone: 'neutral', detail: 'Ready for an agent to pick up.' },
  leased: { label: 'With an agent', tone: 'accent', detail: 'An agent is working on it.' },
  awaitingApproval: { label: 'Needs your approval', tone: 'warning', detail: 'The agent proposed a change. Nothing is applied until you approve it.' },
  committing: { label: 'Saving', tone: 'accent', detail: 'Saving the approved result.' },
  succeeded: { label: 'Done', tone: 'success', detail: '' },
  failed: { label: 'Failed', tone: 'danger', detail: 'It did not finish.' },
  blocked: { label: 'Blocked', tone: 'danger', detail: 'Stopped by a limit, a missing permission or an unavailable agent.' },
  cancelled: { label: 'Cancelled', tone: 'muted', detail: 'Cancelled before it finished.' },
  uncertain: { label: 'Outcome unknown', tone: 'warning', detail: 'COLP couldn’t confirm whether the agent finished. Try again checks that it is safe first.' },
  review: { label: 'Not applied', tone: 'warning', detail: 'Declined or set aside for review. Nothing from this step was applied.' },
  stale: { label: 'Out of date', tone: 'muted', detail: 'The bookmark changed after this started, so its result was not used.' },
}

const DEPENDENCY_KIND: Record<AutomationDependency['kind'], string> = {
  folder: 'Its folder',
  ancestor: 'Folders above it',
  vocabulary: 'Tag list',
  executor: 'Agent',
  subscription: 'Agent wake-up',
  permission: 'Access',
  runtime: 'Automation service',
}

export function dependencyLabel(kind: AutomationDependency['kind']): string {
  return DEPENDENCY_KIND[kind]
}

export const DEPENDENCY_STATUS: Record<AutomationDependency['status'], { label: string; tone: StatusTone }> = {
  valid: { label: 'OK', tone: 'success' },
  warning: { label: 'Check', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'danger' },
}

export const RUN_KIND: Record<AutomationRun['kind'], string> = {
  intake: 'New bookmark',
  batch: 'Batch',
  manual: 'Run once',
}

/* Server explanations, in the owner's words. Exact sentences first, then
   the server's fixed prefixes; anything else is shown verbatim. */
const RUN_EXPLANATIONS: Record<string, string> = {
  'Matched the pinned rule and moved from the default root to its verified canonical destination.': 'Moved into the rule’s folder.',
  'Already in the verified destination; no canonical mutation required.': 'Already in the rule’s folder, so nothing moved.',
  'A compatible rule already committed this placement.': 'Another rule already put it there.',
  'Collection exceeds the existing version-history capacity; no placement was committed.': 'Not moved: the collection is over the version-history limit.',
  'Destination unavailable.': 'Not moved: the rule’s folder is unavailable.',
  'Current Owner authority is unavailable.': 'Not moved: only the collection’s owner can run this rule.',
  'Cancelled by the Owner; recorded effects are retained.': 'Cancelled by you. Anything already done stays.',
  'Explicit hold: awaiting an Owner decision to continue the original pinned work.': 'On hold until you decide to continue.',
  'Canonical device placement verified against the pinned rule and binding.': 'Placed by your browser, and confirmed by the server.',
  'The pinned rule matched; no placement effect was required.': 'Matched, and nothing needed to move.',
  'Equal-priority rules selected incompatible destinations; the original location was preserved.': 'Rules with the same priority chose different folders, so the bookmark stayed where you saved it.',
  'No retained execution explanation is available.': 'No details were kept for this run.',
  'Required binding unavailable; keep original parent.': 'The rule’s folder is unavailable, so the bookmark stayed where you saved it.',
  'Intake destination unavailable.': 'The rule’s folder is unavailable.',
  'Outside rule scope, source policy, trigger or hop bound.': 'Outside what this rule looks at.',
  'Deferred: the immutable source lacks usable input. The original rule, binding and event remain pinned; a newer live bookmark is never substituted. No effect is authorized. The Owner may cancel this deferred run.':
    'Waiting: the bookmark was missing details this rule needs. Nothing was changed; you can cancel it.',
  'Review required: the immutable source lacks usable input. No effect was authorized; a later bookmark edit does not replace this source.':
    'The bookmark was missing details this rule needs, so nothing was changed.',
}

export function runExplanation(text: string | undefined): string | null {
  if (!text) return null
  const known = RUN_EXPLANATIONS[text]
  if (known) return known
  if (text.startsWith('Waiting to place in canonical folder ')) return 'Waiting to move it into the rule’s folder.'
  if (text.startsWith('A higher-priority rule selected canonical folder ')) return 'A higher-priority rule chose another folder, so this one did not run.'
  return text
}

const UNDO_REASONS: Record<string, string> = {
  'Undo moves only this bookmark back to its verified original folder.': 'Moves only this bookmark back to the folder it came from.',
  'One isolated move can be compensated to its verified original folder under current content fences.': 'Moves only this bookmark back to the folder it came from.',
  'This placement has already been reverted.': 'Already undone.',
  'This effect has already been reverted.': 'Already undone.',
  'Placement verified; the canonical original destination was not observed.': 'Can’t undo: the folder it came from was not recorded.',
  'Current Owner authority is unavailable.': 'Can’t undo: only the collection’s owner can undo this.',
  'Current collection Owner authority is unavailable.': 'Can’t undo: only the collection’s owner can undo this.',
  'The original folder is unavailable.': 'Can’t undo: the folder it came from is gone.',
  'A newer canonical change prevents safe Undo.': 'Can’t undo: the bookmark changed after this, so nothing was changed.',
  'The committed plan has no verified version linkage.': 'Can’t undo: this change has no saved version to return to.',
  'The existing tree snapshot cannot isolate this effect. Tags, notes and grouped plans have no safe single-effect Undo.': 'Can’t undo here: tags, notes and grouped changes have no single-step undo.',
  'Later edits or unavailable original placement prevent conservative Undo.': 'Can’t undo: the bookmark changed afterwards, or the folder it came from is gone.',
}

export function undoReason(text: string): string {
  return UNDO_REASONS[text] ?? text
}

const PREVIEW_EXPLANATIONS: Record<string, string> = {
  matched: 'Matches the conditions.',
  notMatched: 'Doesn’t match the conditions.',
  missingInput: 'Missing the details needed to decide.',
  'Imports are excluded by this rule policy.': 'Imported bookmarks are left alone by this rule.',
  'Imports may match this policy; imported placement is always preserved.': 'Imported: may match, but stays where it was imported.',
  'explicitChoice; original location preserved.': 'Matches, but stays in the folder you chose for it.',
  'unknownIntent; original location preserved.': 'Matches, but stays put: a rule files bookmarks as you save them, not ones you already have.',
  authorityOrPrivacy: 'The rule may not move it there (permissions or privacy).',
}

export type PreviewNames = { rules: ReadonlyMap<string, string>; folders: ReadonlyMap<string, string> }

function ruleNames(ids: string, names: PreviewNames): string {
  return ids.split(', ').map((id) => {
    const name = names.rules.get(id.replace(/ \(\+\d+ more\)$/u, ''))
    return name ? `“${name}”` : 'another rule'
  }).join(', ')
}

/** One preview decision in the owner's words. */
export function previewExplanation(decision: AutomationPreviewDecision, names: PreviewNames): string {
  const text = decision.explanation
  const known = PREVIEW_EXPLANATIONS[text] ?? RUN_EXPLANATIONS[text]
  if (known) return known
  const placed = /^Would place in canonical folder (\S+); preview only; no effect\.$/u.exec(text)
  if (placed) return `Would move to ${names.folders.get(placed[1] ?? '') ?? 'the rule’s folder'}.`
  const overridden = /^Higher-priority rules (.+) select canonical folder (\S+); proposed placement would not run; no effect\.$/u.exec(text)
  if (overridden) {
    return `${ruleNames(overridden[1] ?? '', names)} has a higher priority and would send it to ${names.folders.get(overridden[2] ?? '') ?? 'another folder'}.`
  }
  const conflict = /^conflict: equalPriorityDestinations; rules (.+); original location preserved\.$/u.exec(text)
  if (conflict) return `Same priority as ${ruleNames(conflict[1] ?? '', names)}, which wants another folder, so it would stay put.`
  const preserved = /^(.*); original location preserved\.$/u.exec(text)
  if (preserved) return 'Matches, but stays where it is.'
  return text
}

/* Preview notes the server flags as warnings, in the owner's words.
   `immutableInputDeferred` only restates the form's own default (a bookmark
   missing details waits instead of being guessed), and the "Can’t tell" group
   already lists those bookmarks, so it adds nothing. A code this table does
   not know is shown as the server wrote it. */
const PREVIEW_NOTES: Record<string, string | null> = {
  immutableInputDeferred: null,
  ownerRequired: 'Only the collection’s owner can run rules on it. This preview doesn’t change that.',
}

const WORKER_UNAVAILABLE: Record<string, string> = {
  'No explicit execution assignment permits this task.': 'No agent is assigned to one of its tasks yet, so that task would wait.',
  'Task input fields exceed the execution policy allowlist.': 'Its agent may not read everything one of its tasks needs, so that task would wait.',
  'Pinned monetary limits cannot be enforced by this host.': 'This server can’t enforce a money limit, so a task with one would wait.',
}

export function previewNotes(diagnostics: readonly AutomationDiagnostic[]): string[] {
  const notes = new Set<string>()
  for (const item of diagnostics) {
    if (item.severity === 'info') continue
    const known = Object.hasOwn(PREVIEW_NOTES, item.code) ? PREVIEW_NOTES[item.code] : undefined
    const text = known !== undefined
      ? known
      : item.code === 'workerUnavailable' ? WORKER_UNAVAILABLE[item.message] ?? item.message : item.message
    if (text) notes.add(text)
  }
  return [...notes]
}

export const PREVIEW_GROUPS: ReadonlyArray<{
  outcome: AutomationPreviewDecision['outcome']
  label: string
  tone: StatusTone
}> = [
  { outcome: 'matched', label: 'Would match', tone: 'success' },
  { outcome: 'conflict', label: 'Conflict', tone: 'warning' },
  { outcome: 'blocked', label: 'Blocked', tone: 'danger' },
  { outcome: 'missingInput', label: 'Can’t tell', tone: 'muted' },
  { outcome: 'notMatched', label: 'Wouldn’t match', tone: 'neutral' },
]

type IncidentCopy = { title: string; icon: IconName; tone: StatusTone }

/* Titles continue the rule's name: "SSRN papers: its folder was deleted". */
const INCIDENTS: Record<AutomationHealthIncident['code'], IncidentCopy> = {
  bindingDeleted: { title: 'its folder was deleted', icon: 'trash', tone: 'danger' },
  bindingRenamed: { title: 'its folder was renamed', icon: 'info', tone: 'muted' },
  bindingMoved: { title: 'its folder moved', icon: 'move', tone: 'muted' },
  scopeChanged: { title: 'its folder left the rule’s collection', icon: 'folder', tone: 'warning' },
  permissionRevoked: { title: 'you no longer have access to its folder', icon: 'lock', tone: 'danger' },
  executorUnavailable: { title: 'its agent is unavailable', icon: 'terminal', tone: 'warning' },
  subscriptionExpired: { title: 'its agent stopped listening', icon: 'terminal', tone: 'warning' },
  ruleConflict: { title: 'it disagrees with another rule', icon: 'alert', tone: 'warning' },
  inputUnavailable: { title: 'some details it needs are unavailable', icon: 'info', tone: 'warning' },
  runtimeUnsupported: { title: 'rules can’t run on this server yet', icon: 'info', tone: 'muted' },
  highUndoRate: { title: 'you often undo what it does', icon: 'refresh', tone: 'warning' },
  deliveryFailure: { title: 'its agent could not be woken', icon: 'terminal', tone: 'warning' },
}

export function incidentCopy(incident: AutomationHealthIncident): IncidentCopy {
  return INCIDENTS[incident.code]
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Incidents about the rule's folder are repaired by choosing another one. */
export function incidentNeedsFolder(incident: AutomationHealthIncident): boolean {
  return incident.code === 'bindingDeleted' || incident.code === 'scopeChanged' || incident.code === 'permissionRevoked'
}

/** Incidents an agent connection repairs. */
export function incidentNeedsAgent(incident: AutomationHealthIncident): boolean {
  return incident.code === 'executorUnavailable' || incident.code === 'subscriptionExpired' || incident.code === 'deliveryFailure'
}
