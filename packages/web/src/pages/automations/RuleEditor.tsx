import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type {
  AutomationBindingSet,
  AutomationPreviewResult,
  AutomationRule,
  AutomationRuleDefinition,
} from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { Breadcrumb } from '../../components/Breadcrumb'
import { useConfirm, useConfirmLeaveGuard } from '../../components/ConfirmModal'
import { FilterRail } from '../../components/FilterRail'
import { Icon } from '../../components/Icon'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { plural } from '../../lib/plural'
import { CONDITION_OPTIONS, conditionOption, ruleSentence, suggestedRuleName, taskPhrase } from './copy'
import type { FolderEntry } from './folders'
import { PreviewPanel, type PreviewView } from './PreviewPanel'
import {
  bindingInput,
  configurationKey,
  DEFAULT_PRIORITY,
  destinationFolder,
  draftDefinition,
  draftFromDefinition,
  draftFromRule,
  draftProblems,
  draftFromSearch,
  emptyDraft,
  filledConditions,
  newConditionKey,
  ruleInput,
  sameMatch,
  type ConditionKind,
  type RuleDraft,
} from './ruleDraft'
import { Sentence } from './RuleSentence'
import { errorMessage, isStale, RuleStateBadge, useAutomationDeps, useLoad } from './shared'

/* AU-01/AU-02: a rule in three questions (when, where, then), a preview of
   the exact configuration, and only then Turn on. The server owns every
   decision; this page assembles the reviewed contract from the form, keeps
   the binding pointed at the folder's identity, and refuses to offer Turn on
   for anything it has not previewed as-is (AC-26). */

type Loaded = { rule: AutomationRule; binding: AutomationBindingSet | undefined } | null

function folderKey(collectionId: string, nodeId: string) {
  return `${collectionId}/${nodeId}`
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Enough shape for this page to describe it; the server validates everything else. */
function looksLikeDefinition(value: Record<string, unknown>): value is AutomationRuleDefinition {
  const { match } = value
  const grouped = isObject(match) && (match.kind === 'all' || match.kind === 'any')
  return typeof value.name === 'string'
    && isObject(value.scope)
    && isObject(match)
    && (!grouped || (Array.isArray(match.items) && match.items.every(isObject)))
    && isObject(value.trigger)
    && isObject(value.policy)
    && Array.isArray(value.tasks) && value.tasks.every(isObject)
    && Array.isArray(value.roles)
}

export function RuleEditor() {
  const { ruleId } = useParams<{ ruleId?: string }>()
  const [search] = useSearchParams()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { api, folders } = useAutomationDeps()
  const { toast, success, error: toastError } = useToast()
  const creating = ruleId === undefined

  const capabilities = useLoad('capabilities', (signal) => api.getCapabilities(signal))
  const collections = useLoad('collections', (signal) => folders.listCollections(signal))
  const otherRules = useLoad('rules', (signal) => api.listRules(null, signal))
  const existing = useLoad<Loaded>(creating ? 'new' : `rule:${ruleId}`, async (signal) => {
    if (creating) return null
    const rule = await api.getRule(ruleId, signal)
    const binding = await api.getBindingSet(rule.bindingSetId, signal)
    return { rule, binding }
  })

  const [draft, setDraft] = useState<RuleDraft | null>(() => creating ? draftFromSearch(search) : null)
  /** Opened from a rule the extension keeps in one browser ("Add mine to the account"). */
  const fromBrowser = creating && search.get('from') === 'browser'
  const [initialKey, setInitialKey] = useState<string | null>(null)
  /** A definition from Advanced that the form cannot show; it replaces the form's own. */
  const [jsonDefinition, setJsonDefinition] = useState<AutomationRuleDefinition | null>(null)
  const [definitionBase, setDefinitionBase] = useState<AutomationRuleDefinition | null>(null)
  const [preparedBindingId, setPreparedBindingId] = useState<string | null>(null)
  const [policyId, setPolicyId] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [saved, setSaved] = useState<AutomationRule | null>(null)
  const [sessionBindings, setSessionBindings] = useState<Map<string, AutomationBindingSet>>(new Map())
  const [preview, setPreview] = useState<{ key: string; result: AutomationPreviewResult } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | 'enable' | 'archive' | null>(null)
  const [pendingRuns, setPendingRuns] = useState<'hold' | 'continuePinned' | 'cancel'>('hold')
  const [showProblems, setShowProblems] = useState(false)
  const previewRef = useRef<HTMLElement>(null)

  const loaded = existing.state.status === 'ready' ? existing.state.data : null
  const current = saved ?? loaded?.rule ?? null

  // The stored rule seeds the form once; a rule the form cannot show opens in Advanced.
  useEffect(() => {
    if (!loaded || draft) return
    const seeded = draftFromRule(loaded.rule, loaded.binding)
    if (seeded) {
      setDraft(seeded)
    } else {
      const folder = destinationFolder(loaded.rule.definition, loaded.binding)
      setDraft({ ...emptyDraft(folder?.collectionId ?? loaded.rule.definition.scope.collectionId ?? '', folder?.nodeId ?? ''), name: loaded.rule.definition.name })
      setJsonDefinition(loaded.rule.definition)
      setJsonText(JSON.stringify(loaded.rule.definition, null, 2))
      setAdvancedOpen(true)
    }
  }, [loaded, draft])

  const tree = useLoad(draft?.collectionId ? `folders:${draft.collectionId}` : null, (signal) => folders.loadFolders(draft?.collectionId ?? '', signal))
  const folderList: FolderEntry[] = tree.state.status === 'ready' ? tree.state.data.folders : []
  const rootId = tree.state.status === 'ready' ? tree.state.data.rootId : null
  const chosenFolder = draft?.folderId
    ? draft.folderId === rootId
      ? { id: draft.folderId, title: 'Top level', path: 'Top level', depth: -1 }
      : folderList.find((entry) => entry.id === draft.folderId) ?? null
    : null
  const collectionTitle = collections.state.status === 'ready' && draft
    ? collections.state.data.find((item) => item.id === draft.collectionId)?.title ?? null
    : null

  const fallbackName = draft ? suggestedRuleName(filledConditions(draft)[0]?.value ?? '', chosenFolder?.title ?? null) : 'New rule'
  const built = useMemo<AutomationRuleDefinition | null>(() => {
    if (!draft) return null
    if (jsonDefinition) return jsonDefinition
    return draftDefinition(draft, fallbackName, definitionBase ?? loaded?.rule.definition)
  }, [draft, fallbackName, jsonDefinition, definitionBase, loaded])

  // A stored binding is kept while the form still points at its folder (or cannot show it).
  const storedFolder = loaded ? destinationFolder(loaded.rule.definition, loaded.binding) : null
  const keepsStoredBinding = Boolean(loaded && draft && (!storedFolder
    || (storedFolder.collectionId === draft.collectionId && storedFolder.nodeId === draft.folderId)))
  const workerRule = Boolean(built?.tasks.length)
  const workerBindingId = (preparedBindingId ?? loaded?.rule.bindingSetId ?? '').trim()
  const executionPolicyId = workerRule ? (policyId ?? current?.executionPolicyId ?? '').trim() : ''
  const workerConfigured = !workerRule || Boolean(workerBindingId && executionPolicyId)
  const bindingKey = workerRule ? `prepared:${workerBindingId}:policy:${executionPolicyId}` : !draft ? '' : keepsStoredBinding && loaded
    ? `stored:${loaded.rule.bindingSetId}`
    : `folder:${folderKey(draft.collectionId, draft.folderId)}`
  const builtKey = built ? configurationKey(built, bindingKey) : ''
  const dirty = initialKey !== null && builtKey !== initialKey
  // Unchanged, an existing rule is previewed and turned on exactly as stored.
  const definition = !dirty && current && !jsonDefinition ? current.definition : built
  const configKey = definition ? configurationKey(definition, bindingKey) : ''
  const previewView: PreviewView | null = preview ? { result: preview.result, stale: preview.key !== configKey } : null
  const problems = draft && !jsonDefinition ? draftProblems(draft) : []
  const ruleNames = useMemo(() => new Map(
    otherRules.state.status === 'ready' ? otherRules.state.data.items.map((rule) => [rule.id, rule.definition.name]) : [],
  ), [otherRules.state])
  // Rules that are on in this collection with these very conditions and a priority at least as high:
  // the server's arbitration (equal priorities move nothing) said before the owner turns this one on.
  const rivals = useMemo(() => {
    if (!definition?.intake || !draft?.folderId || otherRules.state.status !== 'ready') return []
    return otherRules.state.data.items.filter((rule) => rule.id !== current?.id
      && rule.desiredState === 'enabled'
      && Boolean(rule.definition.intake)
      && rule.definition.scope.collectionId === definition.scope.collectionId
      && rule.definition.trigger.mode === definition.trigger.mode
      && rule.definition.priority >= definition.priority
      && sameMatch(rule.definition.match, definition.match))
  }, [current?.id, definition, draft?.folderId, otherRules.state])
  const rivalKey = rivals.map((rule) => `${rule.id}@${rule.bindingSetId}`).join(',')
  const rivalBindings = useLoad(rivalKey ? `rivals:${rivalKey}` : null, async (signal) => new Map(
    await Promise.all(rivals.map(async (rule) => [rule.id, await api.getBindingSet(rule.bindingSetId, signal)] as const)),
  ))

  // The first complete configuration is the baseline for "unsaved changes".
  useEffect(() => {
    if (initialKey === null && builtKey && (creating || loaded)) setInitialKey(builtKey)
  }, [builtKey, creating, initialKey, loaded])

  // With one collection there is nothing to choose: a new rule starts in it,
  // and a form the owner has not touched yet still counts as untouched.
  const onlyCollection = collections.state.status === 'ready' && collections.state.data.length === 1
    ? collections.state.data[0]?.id ?? null
    : null
  const preselected = useRef(false)
  useEffect(() => {
    if (!creating || !onlyCollection || preselected.current) return
    preselected.current = true
    setDraft((value) => (value && !value.collectionId ? { ...value, collectionId: onlyCollection } : value))
    if (!dirty) setInitialKey(null)
  }, [creating, onlyCollection, dirty])

  useConfirmLeaveGuard(dirty && busy === null, {
    title: 'Leave without saving?',
    body: 'Your changes to this rule are not saved.',
    confirmLabel: 'Leave',
  })

  useEffect(() => {
    if (hash === '#preview' && draft) previewRef.current?.scrollIntoView({ block: 'start' })
  }, [hash, draft])

  if (existing.state.status === 'error') {
    return (
      <PageShell>
        <RouteState
          kind={classifyRouteError(existing.state.error)}
          icon="compass"
          titleAs="h1"
          title={classifyRouteError(existing.state.error) === 'unavailable' ? 'This rule is not available' : undefined}
          description={classifyRouteError(existing.state.error) === 'unavailable' ? 'It may have been archived, or it belongs to another account.' : undefined}
          onRetry={existing.reload}
        />
      </PageShell>
    )
  }
  if (!draft || !definition) {
    return <PageShell><RouteState kind="loading" loadingLabel="Loading rule…" /></PageShell>
  }

  const editing = loaded?.rule ?? null
  // Narrowed once for the handlers below.
  const ruleDefinition: AutomationRuleDefinition = definition
  const form: RuleDraft = draft
  const taskTypes = capabilities.state.status === 'ready' ? capabilities.state.data.taskTypes : []
  const sentence = ruleSentence(definition, {
    collection: collectionTitle,
    folder: workerRule ? null : chosenFolder?.title ?? null,
    draft: true,
  })
  const canPreview = workerRule ? workerConfigured : problems.length === 0 && Boolean(draft.collectionId && draft.folderId)
  const rivalFolders = rivalBindings.state.status === 'ready' ? rivalBindings.state.data : null
  const overlaps = rivalFolders ? rivals.flatMap((rule) => {
    const folder = destinationFolder(rule.definition, rivalFolders.get(rule.id))
    if (!folder || (folder.collectionId === form.collectionId && folder.nodeId === form.folderId)) return []
    const title = folder.nodeId === rootId ? 'Top level' : folderList.find((entry) => entry.id === folder.nodeId)?.title ?? 'another folder'
    return [{ id: rule.id, name: rule.definition.name, folder: title, higher: rule.definition.priority > ruleDefinition.priority }]
  }) : []
  const previewCurrent = previewView !== null && !previewView.stale
  /** The stored rule is on: a change is applied, not turned on. */
  const ruleOn = current?.desiredState === 'enabled'
  const heldRuns = current?.usage?.heldRuns
  /** Held (or uncounted) earlier work: confirming an unchanged rule that is on still decides what happens to it. */
  const earlierWork = heldRuns === undefined || heldRuns > 0
  const canApply = previewCurrent && (!ruleOn || dirty || earlierWork)

  function update(patch: Partial<RuleDraft>) {
    setDraft((value) => (value ? { ...value, ...patch } : value))
  }

  function updateCondition(key: string, patch: Partial<{ kind: ConditionKind; value: string }>) {
    setDraft((value) => value && {
      ...value,
      conditions: value.conditions.map((condition) => (condition.key === key ? { ...condition, ...patch } : condition)),
    })
  }

  async function bindingSetId(): Promise<string> {
    if (workerRule) {
      if (!workerBindingId) throw new Error('Prepare a binding set with the required folder and executor roles, then enter its ID under Advanced.')
      return workerBindingId
    }
    if (keepsStoredBinding && loaded) return loaded.rule.bindingSetId
    const key = folderKey(form.collectionId, form.folderId)
    const known = sessionBindings.get(key)
    if (known) return known.id
    const serverUuid = await folders.serverUuid()
    const created = await api.createBindingSet(bindingInput(
      chosenFolder?.path ?? ruleDefinition.name,
      { serverUuid, collectionId: form.collectionId, nodeId: form.folderId },
      ruleDefinition.intake?.folderRole,
    ))
    setSessionBindings((value) => new Map(value).set(key, created))
    return created.id
  }

  /** Says what is still missing, and puts the cursor on the first of it. */
  function revealProblems() {
    setShowProblems(true)
    if (!workerConfigured) {
      setAdvancedOpen(true)
      const id = workerBindingId ? 'automation-execution-policy' : 'automation-worker-bindings'
      requestAnimationFrame(() => document.getElementById(id)?.focus())
      return
    }
    const first = problems[0]?.field
    const empty = form.conditions.find((condition) => !condition.value.trim())
    const id = first === 'conditions' && empty
      ? `automation-condition-${empty.key}`
      : first === 'folder' ? 'automation-folder' : null
    if (id) document.getElementById(id)?.focus()
  }

  async function runPreview() {
    if (!workerConfigured || (!canPreview && !jsonDefinition)) {
      revealProblems()
      return
    }
    setBusy('preview')
    try {
      const key = configKey
      const result = await api.previewRule({ rule: ruleInput(ruleDefinition, await bindingSetId(), current, executionPolicyId || null), ...(current ? { ruleId: current.id } : {}), mode: 'currentState' })
      setPreview({ key, result })
    } catch (error) {
      toastError(errorMessage(error, 'Could not preview this rule.'))
    } finally {
      setBusy(null)
    }
  }

  /** Stores the configuration on screen; an enabled rule pauses until previewed and turned on again. */
  async function store(): Promise<AutomationRule> {
    const setId = await bindingSetId()
    const base = saved ?? editing
    if (!base) {
      const created = await api.createRule(ruleInput(ruleDefinition, setId, null, executionPolicyId || null))
      setSaved(created)
      return created
    }
    if (!dirty) return base
    const { templateRef: _templateRef, ...input } = ruleInput(ruleDefinition, setId, base, executionPolicyId || null)
    const next = await api.replaceRule(base.id, {
      ...input,
      executionPolicyId: executionPolicyId || null,
      pendingRuns: 'hold',
      counterPolicy: 'resetOnSemanticChange',
    }, base.revision)
    setSaved(next)
    return next
  }

  /** Binding sets this visit created and the saved rule does not use; only never-referenced ones can go. */
  async function tidyBindings(keepId: string) {
    for (const binding of sessionBindings.values()) {
      if (binding.id === keepId) continue
      await api.deleteBindingSet(binding.id, binding.revision).catch(() => undefined)
    }
  }

  async function save() {
    if (problems.length > 0) {
      revealProblems()
      return
    }
    const base = saved ?? editing
    if (base && !dirty) {
      // Nothing to store: the rule keeps its state, so don't claim it was saved or paused.
      toast(`No changes to save in “${base.definition.name}”.`)
      navigate('/automations')
      return
    }
    setBusy('save')
    try {
      const rule = await store()
      setInitialKey(builtKey)
      await tidyBindings(rule.bindingSetId)
      success(base?.desiredState === 'enabled'
        ? `Saved “${rule.definition.name}”. It stays paused until you preview it and turn it on.`
        : rule.desiredState === 'draft'
          ? `Saved “${rule.definition.name}” as a draft.`
          : `Saved “${rule.definition.name}”.`)
      navigate('/automations')
    } catch (error) {
      toastError(errorMessage(error, 'Could not save this rule.'))
    } finally {
      setBusy(null)
    }
  }

  async function turnOn() {
    if (!preview || !canApply) return
    const wasOn = ruleOn
    setBusy('enable')
    try {
      const rule = await store()
      setInitialKey(builtKey)
      const enabled = await api.setRuleLifecycle(rule.id, {
        state: 'enabled',
        pendingRuns: current ? pendingRuns : 'hold',
        activationPreviewId: preview.result.previewId,
        reason: 'Owner turned the rule on after previewing it.',
      }, rule.revision)
      setSaved(enabled)
      await tidyBindings(enabled.bindingSetId)
      success(wasOn
        ? `Applied your changes to “${enabled.definition.name}”. It stays on.`
        : `“${enabled.definition.name}” is on. It files bookmarks you save from now on.`)
      navigate('/automations')
    } catch (error) {
      if (isStale(error)) setPreview(null)
      toastError(isStale(error)
        ? `Something changed since the preview. Preview again, then ${wasOn ? 'apply your changes' : 'turn it on'}.`
        : errorMessage(error, wasOn ? 'Could not apply your changes.' : 'Could not turn this rule on.'))
    } finally {
      setBusy(null)
    }
  }

  async function archive() {
    const target = saved ?? editing
    if (!target) return
    const accepted = await confirm({
      title: `Archive “${target.definition.name}”?`,
      body: 'It stops for good and its waiting work is cancelled. What it already did stays, with its history. You cannot turn an archived rule back on.',
      confirmLabel: 'Archive rule',
    })
    if (!accepted) return
    setBusy('archive')
    try {
      await api.archiveRule(target.id, target.revision)
      setInitialKey(builtKey)
      success(`Archived “${target.definition.name}”.`)
      navigate('/automations')
    } catch (error) {
      toastError(errorMessage(error, 'Could not archive this rule.'))
    } finally {
      setBusy(null)
    }
  }

  function applyJson() {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      setJsonError('This is not valid JSON.')
      return
    }
    if (!isObject(parsed)) {
      setJsonError('Paste a rule definition: one JSON object.')
      return
    }
    if (!looksLikeDefinition(parsed)) {
      setJsonError('A rule definition needs name, roles, scope, match, trigger, tasks and policy.')
      return
    }
    const next = parsed
    setJsonError(null)
    setDefinitionBase(next)
    // A definition the form can show goes back into the form; anything else is kept as written.
    const seeded = form.folderId
      ? draftFromDefinition(next, { collectionId: form.collectionId, nodeId: form.folderId })
      : null
    if (seeded) {
      setDraft(seeded)
      setJsonDefinition(null)
    } else {
      setJsonDefinition(next)
    }
  }

  const title = creating ? 'New rule' : editing?.definition.name ?? 'Rule'
  const conditionsInvalid = showProblems && problems.some((problem) => problem.field === 'conditions')
  const folderInvalid = showProblems && problems.some((problem) => problem.field === 'folder')

  return (
    <PageShell data-testid="automation-editor">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={<Breadcrumb items={[{ label: 'Automations', to: '/automations' }, { label: creating ? 'New rule' : 'Edit rule' }]} />}
        title={title}
        documentTitle={creating ? 'New rule' : `Edit ${title}`}
        lede={creating
          ? 'Say which bookmarks this is for and where they go. You preview it on your own bookmarks before it does anything.'
          : editing?.desiredState === 'enabled'
            ? 'Preview a change, then apply it. Saving without a preview pauses the rule until you turn it on again.'
            : 'Change the rule, preview it, then turn it on.'}
        afterTitle={editing ? <RuleStateBadge state={editing.effectiveState} /> : undefined}
      />

      <form
        className="automation-editor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void runPreview()
        }}
      >
        <div className="automation-editor-main">
          {fromBrowser ? (
            <p className="automation-json-note" role="status" data-testid="automation-from-browser">
              <Icon name="browser" />
              <span>Filled in from a rule in your browser. Preview it, then turn it on to use it on every device.</span>
            </p>
          ) : null}
          {jsonDefinition ? (
            <p className="automation-json-note" role="status" data-testid="automation-json-note">
              <Icon name="code" />
              <span>This rule uses options the form can’t show. Edit it as JSON below; the folder in step 1 still applies.</span>
            </p>
          ) : null}
          <div className="automation-form">
            <ol className="automation-steps">
              {!jsonDefinition && (
                <li className="automation-step" aria-labelledby="automation-step-when">
                  <div className="automation-step-head">
                    <span className="automation-step-index" aria-hidden>1</span>
                    <h2 id="automation-step-when">When you save a bookmark that…</h2>
                  </div>
                  {draft.conditions.length > 1 && (
                    <div className="automation-combinator">
                      <span id="automation-combinator-label">Match</span>
                      <FilterRail<RuleDraft['combinator']>
                        variant="segments"
                        className="view-switch"
                        labelledBy="automation-combinator-label"
                        label="Match"
                        value={draft.combinator}
                        options={[{ value: 'all', label: 'All of these' }, { value: 'any', label: 'Any of these' }]}
                        onChange={(combinator) => update({ combinator })}
                      />
                    </div>
                  )}
                  <ul className="automation-conditions">
                    {draft.conditions.map((condition, index) => {
                      const option = conditionOption(condition.kind)
                      const inputId = `automation-condition-${condition.key}`
                      return (
                        <li key={condition.key} className="automation-condition">
                          <div className="automation-condition-row">
                            <div className="field automation-condition-kind">
                              <label className="visually-hidden" htmlFor={`${inputId}-kind`}>Condition {index + 1}</label>
                              <select
                                id={`${inputId}-kind`}
                                value={condition.kind}
                                onChange={(event) => updateCondition(condition.key, { kind: event.target.value as ConditionKind })}
                              >
                                {CONDITION_OPTIONS.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}
                              </select>
                            </div>
                            <div className="field">
                              <label className="visually-hidden" htmlFor={inputId}>{option.label}</label>
                              <input
                                id={inputId}
                                value={condition.value}
                                placeholder={option.placeholder}
                                autoComplete="off"
                                spellCheck={false}
                                maxLength={condition.kind === 'pathStartsWith' ? 1024 : 200}
                                aria-describedby={`${inputId}-hint`}
                                aria-invalid={conditionsInvalid && !condition.value.trim() ? true : undefined}
                                onChange={(event) => updateCondition(condition.key, { value: event.target.value })}
                              />
                            </div>
                            {draft.conditions.length > 1 && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm automation-condition-remove"
                                aria-label={`Remove condition ${index + 1}`}
                                onClick={() => update({ conditions: draft.conditions.filter((item) => item.key !== condition.key) })}
                              >
                                <Icon name="cross" />
                              </button>
                            )}
                          </div>
                          <p className="field-hint" id={`${inputId}-hint`}>{option.hint}</p>
                        </li>
                      )
                    })}
                  </ul>
                  {conditionsInvalid && <p className="field-error" role="alert">Add at least one condition.</p>}
                  {draft.conditions.length < 8 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm automation-add"
                      onClick={() => update({ conditions: [...draft.conditions, { key: newConditionKey(), kind: 'siteIs', value: '' }] })}
                    >
                      <Icon name="plus" />
                      Add condition
                    </button>
                  )}
                </li>
              )}

              {!workerRule && <li className="automation-step" aria-labelledby="automation-step-where">
                <div className="automation-step-head">
                  <span className="automation-step-index" aria-hidden>{jsonDefinition ? 1 : 2}</span>
                  <h2 id="automation-step-where">…move it to</h2>
                </div>
                <div className="automation-where">
                  <div className="field">
                    <label htmlFor="automation-folder">Folder</label>
                    <select
                      id="automation-folder"
                      value={draft.folderId}
                      disabled={!draft.collectionId || tree.state.status !== 'ready'}
                      aria-invalid={folderInvalid && !draft.folderId ? true : undefined}
                      onChange={(event) => update({ folderId: event.target.value })}
                    >
                      <option value="">{draft.collectionId && tree.state.status === 'loading' ? 'Loading folders…' : 'Choose a folder'}</option>
                      {folderList.map((entry) => <option key={entry.id} value={entry.id}>{entry.path}</option>)}
                    </select>
                  </div>
                </div>
                {folderInvalid && <p className="field-error" role="alert">Choose the folder bookmarks go to.</p>}
                {tree.state.status === 'error' && (
                  <p className="field-error" role="alert">{errorMessage(tree.state.error, 'Could not load the folders of your library.')}</p>
                )}
                {draft.folderId && tree.state.status === 'ready' && !chosenFolder && (
                  <p className="field-error" role="alert">This folder is gone. Choose another one.</p>
                )}
                {tree.state.status === 'ready' && folderList.length === 0 && (
                  <p className="field-hint">Your library has no folders yet. Create one there first.</p>
                )}
                <p className="field-hint">
                  The rule follows the folder itself, so renaming or moving it later keeps the rule working.
                  It applies to bookmarks saved anywhere in your library.
                </p>
              </li>}

              {taskTypes.length > 0 && (
                <li className="automation-step" aria-labelledby="automation-step-then">
                  <div className="automation-step-head">
                    <span className="automation-step-index" aria-hidden>{jsonDefinition ? 2 : 3}</span>
                    <h2 id="automation-step-then">Then <span className="automation-optional">optional</span></h2>
                  </div>
                  {definition.tasks.length > 0 && (
                    <ul className="automation-task-list">
                      {definition.tasks.map((task) => (
                        <li key={task.id}><Icon name="terminal" /> Ask an agent to {taskPhrase(task.type)}</li>
                      ))}
                    </ul>
                  )}
                  {/* Plain words here; the IDs an agent task needs live under Advanced. */}
                  <p className="field-hint">
                    {definition.tasks.length > 0 ? (
                      <>An agent worker does these after the bookmark is filed; filing never waits for it. Its setup is under Advanced.</>
                    ) : (
                      <>
                        A rule can also ask an agent to summarize or tag what it files. That needs a worker
                        paired on <Link to="/agents">Agents</Link>; a rule that only files bookmarks needs none.
                      </>
                    )}
                  </p>
                </li>
              )}
            </ol>

            {/* A JSON-only rule keeps its name, priority and cap in the JSON. */}
            {!jsonDefinition && (
              <details className="automation-disclosure">
                <summary>
                  <Icon name="chevron-right" className="automation-disclosure-chevron" />
                  More options
                  <span className="automation-summary-note">Name, priority, daily limit</span>
                </summary>
                <div className="automation-options">
                  <div className="field">
                    <label htmlFor="automation-name">Name</label>
                    <input
                      id="automation-name"
                      value={draft.name}
                      placeholder={fallbackName}
                      maxLength={200}
                      autoComplete="off"
                      onChange={(event) => update({ name: event.target.value })}
                    />
                    <p className="field-hint">Shown in your rule list. Left empty, the rule is named “{fallbackName}”.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="automation-priority">Priority</label>
                    <input
                      id="automation-priority"
                      type="number"
                      inputMode="numeric"
                      min={-1000}
                      max={1000}
                      value={draft.priority}
                      onChange={(event) => update({ priority: Number.isFinite(event.target.valueAsNumber) ? Math.trunc(event.target.valueAsNumber) : DEFAULT_PRIORITY })}
                    />
                    <p className="field-hint">When two rules want different folders for one bookmark, the higher priority wins. Equal priorities leave it where you saved it.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="automation-daily">Most runs a day</label>
                    <input
                      id="automation-daily"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10000}
                      value={draft.maxRunsPerDay}
                      onChange={(event) => update({ maxRunsPerDay: Number.isFinite(event.target.valueAsNumber) ? Math.max(1, Math.trunc(event.target.valueAsNumber)) : 100 })}
                    />
                    <p className="field-hint">A safety cap. Bookmarks past it are still saved, just not filed.</p>
                  </div>
                </div>
              </details>
            )}

            <details
              className="automation-disclosure"
              open={advancedOpen}
              onToggle={(event) => {
                const open = (event.currentTarget as HTMLDetailsElement).open
                setAdvancedOpen(open)
                if (open && !jsonDefinition) setJsonText(JSON.stringify(definition, null, 2))
              }}
            >
              <summary>
                <Icon name="chevron-right" className="automation-disclosure-chevron" />
                Advanced: edit as JSON
              </summary>
              <div className="automation-json">
                <p className="field-hint">
                  The rule definition as the server stores it, for copying, pasting, or agents. For filing rules, choose the destination folder in the form.
                </p>
                {workerRule && <fieldset className="automation-options">
                  <legend>Agent configuration</legend>
                  <p className="field-hint">
                    First connect and pair a worker in <Link to="/agents">Agents</Link>.
                    Use the automation API or a management tool to create an executor for that target,
                    a binding set containing every folder and executor role in this definition, and an execution policy
                    assigning each task type to its executor role with allowed input data and call limits.
                    This editor uses those existing resources; pasting task JSON alone does not prepare them.
                  </p>
                  <div className="field">
                    <label htmlFor="automation-worker-bindings">Prepared binding set ID</label>
                    <input id="automation-worker-bindings" value={workerBindingId} maxLength={128}
                      onChange={event => setPreparedBindingId(event.target.value)} />
                    <p className="field-hint">Includes the destination folders and explicit executor IDs. These bindings determine the task destinations.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="automation-execution-policy">Execution policy ID</label>
                    <input id="automation-execution-policy" value={executionPolicyId} maxLength={128}
                      onChange={event => setPolicyId(event.target.value)} />
                  </div>
                  {!workerConfigured && <p className="field-hint" role="status">Enter both configuration IDs before previewing and turning on agent tasks.</p>}
                </fieldset>}
                <div className="field">
                  <label className="visually-hidden" htmlFor="automation-json">Rule definition JSON</label>
                  <textarea
                    id="automation-json"
                    className="automation-json-text"
                    spellCheck={false}
                    rows={14}
                    value={jsonText}
                    aria-invalid={jsonError ? true : undefined}
                    onChange={(event) => setJsonText(event.target.value)}
                  />
                </div>
                {jsonError && <p className="field-error" role="alert">{jsonError}</p>}
                <div className="automation-json-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={applyJson}>Apply JSON</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJsonText(JSON.stringify(definition, null, 2))}>
                    Reset to current rule
                  </button>
                </div>
              </div>
            </details>
          </div>
        </div>

        <aside className="automation-editor-side automation-review" id="preview" ref={previewRef} aria-label="Review and turn on">
          <section className="automation-summary" aria-labelledby="automation-summary-heading">
            <h2 id="automation-summary-heading" className="automation-panel-title">This rule</h2>
            <Sentence parts={sentence} />
            {overlaps.map((item) => (
              <p key={item.id} className="automation-overlap" role="status" data-testid="automation-overlap">
                {item.higher
                  ? `“${item.name}” has a higher priority and sends these bookmarks to ${item.folder}, so this rule won’t move them.`
                  : `“${item.name}” sends these bookmarks to ${item.folder} at the same priority. With both on, neither moves them: give one a higher priority ${jsonDefinition ? 'in the JSON' : 'under More options'}.`}
              </p>
            ))}
          </section>
          <PreviewPanel
            preview={previewView}
            busy={busy === 'preview'}
            collectionTitle={collectionTitle}
            names={{ rules: ruleNames, folders: new Map(chosenFolder ? [[chosenFolder.id, chosenFolder.title]] : []) }}
            disabled={busy !== null}
            onPreview={() => void runPreview()}
          />
          <div className="automation-editor-actions">
            {current && previewCurrent && earlierWork && (
              <fieldset className="automation-pending-runs" data-testid="automation-pending-runs">
                <legend>{heldRuns === undefined ? 'Earlier work' : `Earlier work: ${plural(heldRuns, 'run')} on hold`}</legend>
                <p className="automation-meta">Choose what happens to work this rule started before it was paused or edited.</p>
                <label><input type="radio" name="pendingRuns" value="hold" checked={pendingRuns === 'hold'} onChange={() => setPendingRuns('hold')} /> Keep on hold</label>
                <label><input type="radio" name="pendingRuns" value="continuePinned" checked={pendingRuns === 'continuePinned'} onChange={() => setPendingRuns('continuePinned')} /> Continue with its original rule, bindings and input</label>
                <label><input type="radio" name="pendingRuns" value="cancel" checked={pendingRuns === 'cancel'} onChange={() => setPendingRuns('cancel')} /> Cancel remaining work</label>
              </fieldset>
            )}
            <button
              type="button"
              className="btn btn-primary"
              data-testid="automation-turn-on"
              disabled={!canApply || busy !== null}
              aria-describedby="automation-turn-on-hint"
              onClick={() => void turnOn()}
            >
              {busy === 'enable' ? (ruleOn ? 'Applying…' : 'Turning on…') : ruleOn ? 'Apply changes' : 'Turn on'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : creating && !saved ? 'Save as draft' : ruleOn && dirty ? 'Save and pause' : 'Save changes'}
            </button>
            <Link className="btn btn-ghost" to="/automations">Cancel</Link>
            <p className="automation-meta automation-editor-hint" id="automation-turn-on-hint">
              {ruleOn
                ? previewCurrent
                  ? canApply ? 'Applies exactly what you previewed. The rule stays on.' : 'Nothing to apply: the rule is on as it is.'
                  : dirty ? 'Preview your change to apply it. Until then the rule keeps working as it is.' : 'It’s on. Change it, then preview the change to apply it.'
                : previewCurrent ? 'Turns the rule on exactly as previewed.' : 'Preview the rule as it is now to turn it on.'}
            </p>
          </div>
        </aside>

        {/* After the review panel in the page's order, so a phone reaches Turn on before Archive. */}
        {editing && editing.desiredState !== 'archived' && (
          <div className="automation-danger-zone">
            <p className="automation-meta">Archiving stops this rule for good. What it already did stays, with its history.</p>
            <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy !== null} onClick={() => void archive()}>
              Archive rule
            </button>
          </div>
        )}
      </form>
    </PageShell>
  )
}
