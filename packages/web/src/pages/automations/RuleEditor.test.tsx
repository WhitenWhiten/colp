// @vitest-environment happy-dom
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { binding, buttonNamed, choose, click, deps, fakeApi, rule, typeInto } from './automations.test-helper'

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
    expect(api.previewRule).toHaveBeenCalledWith({ rule: { definition: expect.objectContaining({ name: 'Papers to Academic' }), bindingSetId: 'bind-rule-arxiv' }, mode: 'currentState' })
    click(turnOn())
    await waitForDom(() => api.setRuleLifecycle.mock.calls.length === 1)
    expect(api.createBindingSet).not.toHaveBeenCalled()
    expect(api.replaceRule).not.toHaveBeenCalled()
    expect(api.setRuleLifecycle).toHaveBeenCalledWith('rule-arxiv', expect.objectContaining({ activationPreviewId: 'preview-1' }), '5')
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
