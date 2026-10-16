// @vitest-environment happy-dom
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { binding, buttonNamed, choose, click, deps, fakeApi, rule, typeInto, usage } from './automations.test-helper'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function mount(route: string, api = fakeApi()) {
  renderWithRouter(
    <Routes>
      <Route path="/automations/*" element={<Automations deps={deps(api)} />} />
    </Routes>,
    { route },
  )
  return api
}

const select = (id: string) => document.getElementById(id) as HTMLSelectElement
const turnOn = () => document.querySelector<HTMLButtonElement>('[data-testid="automation-turn-on"]')
const conditionInput = () => document.querySelector<HTMLInputElement>('input[id^="automation-condition-"]')

async function readyNew(api = fakeApi()) {
  mount('/automations/new?collectionId=col-personal&folderId=f-academic', api)
  await waitForDom(() => select('automation-folder')?.value === 'f-academic')
  return api
}

async function preview(api: ReturnType<typeof fakeApi>, calls = 1) {
  click(buttonNamed(/^Preview( again)?$/))
  await waitForDom(() => api.previewRule.mock.calls.length === calls && turnOn()?.disabled === false)
}

describe('Rule editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('opens from Automate… with the folder already chosen, and Advanced closed', async () => {
    await readyNew()
    expect(select('automation-collection').value).toBe('col-personal')
    expect([...select('automation-folder').options].map((option) => option.textContent))
      .toEqual(['Choose a folder', 'Academic', 'Reading', 'Reading › Design'])
    const advanced = [...document.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent === 'Advanced: edit as JSON')
    expect(advanced?.open).toBe(false)
    expect(document.querySelector('[data-testid="automation-sentence"]')?.textContent)
      .toBe('When a bookmark saved to Personal matches its conditions, move it to Academic.')
  })

  it('opens filled in from a browser rule, and creates nothing until the owner saves (AC-72)', async () => {
    const api = fakeApi()
    mount('/automations/new?collectionId=col-personal&folderId=f-academic&name=arxiv.org%20%E2%86%92%20Academic&combinator=any'
      + '&condition=siteIs%3Aarxiv.org&condition=titleContains%3APaper&from=browser', api)
    await waitForDom(() => select('automation-folder')?.value === 'f-academic')
    expect(document.querySelector('[data-testid="automation-from-browser"]')?.textContent)
      .toBe('Filled in from a rule in your browser. Preview it, then turn it on to use it on every device.')
    expect([...document.querySelectorAll<HTMLInputElement>('input[id^="automation-condition-"]')].map((input) => input.value)).toEqual(['arxiv.org', 'Paper'])
    expect(document.querySelector('[data-testid="automation-sentence"]')?.textContent).toContain('Academic')
    expect(api.createRule).not.toHaveBeenCalled()
    expect(api.createBindingSet).not.toHaveBeenCalled()
    await preview(api)
    expect(api.previewRule).toHaveBeenCalledWith({ rule: { definition: expect.objectContaining({ name: 'arxiv.org → Academic',
      match: { kind: 'any', items: [{ kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' },
        { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' }] } }), bindingSetId: 'bind-new' }, mode: 'currentState' })
    expect(api.createRule).not.toHaveBeenCalled()
  })

  it('shows no browser note for an ordinary new rule', async () => {
    await readyNew()
    expect(document.querySelector('[data-testid="automation-from-browser"]')).toBeNull()
  })

  it('keeps Turn on off until the exact rule is previewed, and again after any change (AC-26)', async () => {
    const api = await readyNew()
    expect(turnOn()?.disabled).toBe(true)
    const input = conditionInput()
    if (!input) throw new Error('no condition input')
    typeInto(input, 'arxiv.org')
    expect(turnOn()?.disabled).toBe(true)

    await preview(api)
    expect(api.createBindingSet).toHaveBeenCalledWith({
      name: 'Academic',
      values: { destination: expect.objectContaining({ kind: 'folder', folder: { serverUuid: 'server-demo', collectionId: 'col-personal', nodeId: 'f-academic' } }) },
    })
    expect(api.previewRule).toHaveBeenCalledWith({
      rule: { definition: expect.objectContaining({ match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' } }), bindingSetId: 'bind-new' },
      mode: 'currentState',
    })
    expect(document.querySelector('[aria-label="Preview totals"]')?.textContent).toContain('1')
    expect(document.querySelector('section[aria-labelledby="automation-preview-heading"]')?.textContent).toContain('Would move to Academic.')

    typeInto(input, 'arxiv.org/abs')
    expect(turnOn()?.disabled).toBe(true)
    expect(document.querySelector('section[aria-labelledby="automation-preview-heading"]')?.textContent).toContain('You changed the rule after this preview.')

    typeInto(input, 'arxiv.org')
    expect(turnOn()?.disabled).toBe(false)
  })

  it('a new folder is a new configuration: the old preview no longer counts', async () => {
    const api = await readyNew()
    const input = conditionInput()
    if (!input) throw new Error('no condition input')
    typeInto(input, 'arxiv.org')
    await preview(api)
    choose(select('automation-folder'), 'f-reading')
    expect(turnOn()?.disabled).toBe(true)
  })

  it('creates the rule, then turns it on with the preview’s id (AU-02)', async () => {
    const api = await readyNew()
    const input = conditionInput()
    if (!input) throw new Error('no condition input')
    typeInto(input, 'arxiv.org')
    await preview(api)
    click(turnOn())
    await waitForDom(() => api.setRuleLifecycle.mock.calls.length === 1)
    expect(api.createRule).toHaveBeenCalledWith({ definition: expect.objectContaining({ name: 'arxiv.org → Academic' }), bindingSetId: 'bind-new' })
    expect(api.setRuleLifecycle).toHaveBeenCalledWith('rule-new', expect.objectContaining({ state: 'enabled', activationPreviewId: 'preview-1' }), '1')
    expect(api.createRule.mock.invocationCallOrder[0]).toBeLessThan(api.setRuleLifecycle.mock.invocationCallOrder[0] ?? 0)
    await waitForDom(() => toast.success.mock.calls.length === 1)
    expect(document.querySelector('[data-testid="automation-editor"]')).toBeNull()
  })

  it('asks to preview again when the server says the preview went stale', async () => {
    const api = await readyNew()
    api.setRuleLifecycle.mockRejectedValueOnce(new ProductApiError({ status: 409, code: 'automation_stale_input', message: 'Preview expired.' }))
    const input = conditionInput()
    if (!input) throw new Error('no condition input')
    typeInto(input, 'arxiv.org')
    await preview(api)
    click(turnOn())
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(toast.error).toHaveBeenCalledWith('Something changed since the preview. Preview again, then turn it on.')
    expect(turnOn()?.disabled).toBe(true)
  })

  it('says what is missing instead of sending an incomplete rule', async () => {
    const api = mount('/automations/new')
    await waitForDom(() => select('automation-collection')?.disabled === false)
    click(buttonNamed('Save as draft'))
    await waitForDom(() => document.querySelectorAll('[role="alert"]').length === 2)
    expect([...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent))
      .toEqual(['Add at least one condition.', 'Choose the folder bookmarks go to.'])
    expect(api.createRule).not.toHaveBeenCalled()
    expect(api.createBindingSet).not.toHaveBeenCalled()
  })

  it('previews and turns on a stored rule as stored, with its own binding and revision', async () => {
    const api = fakeApi()
    api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic', { desiredState: 'paused', effectiveState: 'paused', revision: '5' }))
    api.getBindingSet.mockResolvedValue(binding('bind-rule-arxiv', 'f-academic'))
    mount('/automations/rules/rule-arxiv/edit', api)
    await waitForDom(() => select('automation-folder')?.value === 'f-academic' && conditionInput()?.value === 'arxiv.org')
    await preview(api)
    expect(api.previewRule).toHaveBeenCalledWith({ rule: { definition: expect.objectContaining({ name: 'Papers to Academic' }), bindingSetId: 'bind-rule-arxiv' }, ruleId: 'rule-arxiv', mode: 'currentState' })
    click(turnOn())
    await waitForDom(() => api.setRuleLifecycle.mock.calls.length === 1)
    expect(api.createBindingSet).not.toHaveBeenCalled()
    expect(api.replaceRule).not.toHaveBeenCalled()
    expect(api.setRuleLifecycle).toHaveBeenCalledWith('rule-arxiv', expect.objectContaining({ activationPreviewId: 'preview-1' }), '5')
  })

  it('does not treat a failed binding read as an empty binding', async () => {
    const api = fakeApi()
    api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers'))
    api.getBindingSet.mockRejectedValue(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'Binding unavailable.' }))
    mount('/automations/rules/rule-arxiv/edit', api)
    await waitForDom(() => document.body.textContent?.includes("Couldn't load this page") === true)
    expect(turnOn()).toBeNull()
    expect(api.previewRule).not.toHaveBeenCalled()
  })

  it.each([
    ['hold', 'Keep on hold'],
    ['continuePinned', 'Continue with its original rule, bindings and input'],
    ['cancel', 'Cancel remaining work'],
  ] as const)('lets the owner choose %s for earlier work after preview', async (policy, label) => {
    const api = fakeApi()
    api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers', { desiredState: 'paused', effectiveState: 'paused', revision: '5', usage: usage({ heldRuns: 2 }) }))
    mount('/automations/rules/rule-arxiv/edit', api)
    await waitForDom(() => conditionInput()?.value === 'arxiv.org')
    await preview(api)
    expect(document.querySelector('[data-testid="automation-pending-runs"]')?.textContent).toContain('2 held runs')
    if (policy !== 'hold') click(document.querySelector<HTMLInputElement>(`input[value="${policy}"]`))
    expect(document.querySelector<HTMLInputElement>(`input[value="${policy}"]`)?.closest('label')?.textContent).toContain(label)
    click(turnOn())
    await waitForDom(() => api.setRuleLifecycle.mock.calls.length === 1)
    expect(api.setRuleLifecycle.mock.calls[0]?.[1].pendingRuns).toBe(policy)
  })

  it('opens a rule the form cannot show in Advanced, as JSON', async () => {
    const api = fakeApi()
    const stored = rule('rule-neg', 'Not arxiv')
    api.getRule.mockResolvedValue({ ...stored, definition: { ...stored.definition, match: { kind: 'not', item: stored.definition.match } } })
    api.getBindingSet.mockResolvedValue(binding('bind-rule-neg', 'f-academic'))
    mount('/automations/rules/rule-neg/edit', api)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-json-note"]')))
    const advanced = [...document.querySelectorAll('details')].find((item) => item.querySelector('summary')?.textContent === 'Advanced: edit as JSON')
    expect(advanced?.open).toBe(true)
    expect((document.getElementById('automation-json') as HTMLTextAreaElement).value).toContain('"kind": "not"')
    expect(conditionInput()).toBeNull()
    // Name, priority and the daily cap live in the JSON; an empty "More options" is not offered.
    expect([...document.querySelectorAll('summary')].map((item) => item.textContent)).not.toContain('More options')
  })


  it('requires prepared agent resources and sends both IDs through preview, create and activation', async () => {
    const api = await readyNew()
    const definition = rule('worker', 'New worker').definition
    definition.tasks = [{ id: 'summary', type: 'summary.generate', after: [], executorRole: 'worker', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['url'], instruction: 'Summarize.' }]
    definition.roles.push({ key: 'worker', kind: 'executor', required: true, description: 'Worker' })
    typeInto(document.getElementById('automation-json') as HTMLTextAreaElement, JSON.stringify(definition))
    click(buttonNamed('Apply JSON'))
    await waitForDom(() => Boolean(document.getElementById('automation-worker-bindings')))
    expect(document.body.textContent).toContain('pasting task JSON alone does not prepare them')
    expect(buttonNamed(/^Preview( again)?$/)?.disabled).toBe(true)
    typeInto(document.getElementById('automation-worker-bindings') as HTMLInputElement, 'prepared-bindings')
    typeInto(document.getElementById('automation-execution-policy') as HTMLInputElement, 'policy-1')
    await preview(api)
    expect(api.previewRule.mock.calls[0]?.[0].rule).toEqual({ definition, bindingSetId: 'prepared-bindings', executionPolicyId: 'policy-1' })
    typeInto(document.getElementById('automation-execution-policy') as HTMLInputElement, 'policy-2')
    expect(turnOn()?.disabled).toBe(true)
    await preview(api, 2)
    typeInto(document.getElementById('automation-worker-bindings') as HTMLInputElement, 'other-bindings')
    expect(turnOn()?.disabled).toBe(true)
    await preview(api, 3)
    click(turnOn())
    await waitForDom(() => api.setRuleLifecycle.mock.calls.length === 1)
    expect(api.createRule).toHaveBeenCalledWith({ definition, bindingSetId: 'other-bindings', executionPolicyId: 'policy-2' })
    expect(api.createBindingSet).not.toHaveBeenCalled()
    expect(api.setRuleLifecycle.mock.calls[0]?.[1].activationPreviewId).toBe('preview-1')
  })

  it('preserves worker policy and template metadata through edit, preview, save and enable', async () => {
    const api = fakeApi()
    let stored = rule('worker', 'Worker', { executionPolicyId: 'policy-1', templateRef: 'template-1' })
    stored.definition.tasks = [{ id: 'summary', type: 'summary.generate', after: [], executorRole: 'worker', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['url'], instruction: 'Summarize.' }]
    stored.definition.roles.push({ key: 'worker', kind: 'executor', required: true, description: 'Worker' })
    const original = structuredClone(stored)
    let previewed: unknown
    api.getRule.mockImplementation(async () => stored)
    api.getBindingSet.mockResolvedValue(binding(stored.bindingSetId, 'f-academic'))
    api.previewRule.mockImplementation(async (input) => {
      expect(input.ruleId).toBe(stored.id)
      previewed = structuredClone(input.rule)
      return { previewId: 'worker-preview', sideEffects: false, decisions: [], diagnostics: [], plannedRunCount: 0,
        remainderCount: 0, completeHistory: false, truncated: false }
    })
    api.replaceRule.mockImplementation(async (_id, input) => {
      stored = { ...stored, definition: input.definition, bindingSetId: input.bindingSetId,
        executionPolicyId: input.executionPolicyId ?? undefined, revision: '4', desiredState: 'paused', effectiveState: 'paused' }
      return stored
    })
    api.setRuleLifecycle.mockImplementation(async (_id, input, revision) => {
      expect(revision).toBe(stored.revision)
      expect(input.activationPreviewId).toBe('worker-preview')
      expect(previewed).toEqual({ definition: stored.definition, bindingSetId: stored.bindingSetId,
        executionPolicyId: stored.executionPolicyId, templateRef: stored.templateRef })
      stored = { ...stored, desiredState: 'enabled', effectiveState: 'active' }
      return stored
    })
    mount('/automations/rules/worker/edit', api)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-json-note"]')))
    const next = structuredClone(original.definition)
    next.name = 'Edited worker'
    next.tasks[0]!.instruction = 'Summarize with sources.'
    typeInto(document.getElementById('automation-json') as HTMLTextAreaElement, JSON.stringify(next))
    click(buttonNamed('Apply JSON'))
    await preview(api)
    click(turnOn())
    await waitForDom(() => toast.success.mock.calls.length === 1)
    expect(stored).toMatchObject({ executionPolicyId: 'policy-1', templateRef: 'template-1', definition: next, desiredState: 'enabled' })
    expect(api.replaceRule).toHaveBeenCalledOnce()
    expect(api.setRuleLifecycle).toHaveBeenCalledOnce()
  })

  it.each(['new', 'existing'])('keeps the entire applied Advanced JSON for a %s rule and subsequent form edits', async (kind) => {
    const api = fakeApi()
    const original = rule('json', 'JSON rule')
    if (kind === 'new') await readyNew(api)
    else {
      api.getRule.mockResolvedValue(original)
      api.getBindingSet.mockResolvedValue(binding(original.bindingSetId, 'f-academic'))
      mount('/automations/rules/json/edit', api)
      await waitForDom(() => conditionInput()?.value === 'arxiv.org')
    }
    const next = structuredClone(original.definition)
    next.description = 'Description edited in Advanced JSON'
    next.policy.imports = 'include'
    next.policy.maxHops = 4
    next.roles[0]!.description = 'Custom destination description'
    next.intake!.satisfies = []
    next.priority = 12
    next.match = { kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Paper' }
    typeInto(document.getElementById('automation-json') as HTMLTextAreaElement, JSON.stringify(next))
    click(buttonNamed('Apply JSON'))
    await waitForDom(() => conditionInput()?.value === 'Paper')
    expect(document.querySelector('[data-testid="automation-json-note"]')).toBeNull()
    typeInto(document.getElementById('automation-name') as HTMLInputElement, 'Edited in form')
    await preview(api)
    expect(api.previewRule.mock.calls[0]![0].rule.definition).toEqual({ ...next, name: 'Edited in form' })
    click(buttonNamed(kind === 'new' ? 'Save as draft' : 'Save changes'))
    await waitForDom(() => toast.success.mock.calls.length === 1)
    const submitted = kind === 'new' ? api.createRule.mock.calls[0]![0] : api.replaceRule.mock.calls[0]![1]
    expect(submitted.definition).toEqual({ ...next, name: 'Edited in form' })
  })

  it('refuses pasted JSON that is not a whole rule definition, and keeps the page', async () => {
    await readyNew()
    const textarea = document.getElementById('automation-json') as HTMLTextAreaElement
    typeInto(textarea, '{"name": "Half a rule"}')
    click(buttonNamed('Apply JSON'))
    await waitForDom(() => Boolean(document.querySelector('[role="alert"]')))
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('A rule definition needs name, roles, scope, match, trigger, tasks and policy.')
    expect(document.querySelector('[data-testid="automation-json-note"]')).toBeNull()
    expect(document.querySelector('[data-testid="automation-sentence"]')?.textContent)
      .toBe('When a bookmark saved to Personal matches its conditions, move it to Academic.')
  })

  it('does not claim an unchanged rule was saved or paused', async () => {
    const api = fakeApi()
    api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic'))
    api.getBindingSet.mockResolvedValue(binding('bind-rule-arxiv', 'f-academic'))
    mount('/automations/rules/rule-arxiv/edit', api)
    await waitForDom(() => select('automation-folder')?.value === 'f-academic' && conditionInput()?.value === 'arxiv.org')
    click(buttonNamed('Save changes'))
    await waitForDom(() => toast.toast.mock.calls.length === 1)
    expect(toast.toast).toHaveBeenCalledWith('No changes to save in “Papers to Academic”.')
    expect(toast.success).not.toHaveBeenCalled()
    expect(api.replaceRule).not.toHaveBeenCalled()
  })
})
