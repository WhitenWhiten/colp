// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteTldrEditor, type NoteTldrMeta } from './useNoteTldrEditor'
import { cleanup, mountTree } from '../test/render'

const initial: NoteTldrMeta = { note: 'n0', tldr: 't0', tldrSource: 'user' }

function Harness({
  meta = initial,
  persist,
  generate,
  notify,
}: {
  meta?: NoteTldrMeta
  persist: (patch: Partial<NoteTldrMeta>) => NoteTldrMeta
  generate: () => Promise<string>
  notify: (message: string, tone: 'plain' | 'success') => void
}) {
  const editor = useNoteTldrEditor({ initial: meta, persist, generate, notify })
  return (
    <div>
      <output data-testid="state">
        {JSON.stringify({
          note: editor.note,
          tldr: editor.tldr,
          tldrSource: editor.tldrSource,
          noteFormat: editor.noteFormat,
          tldrFormat: editor.tldrFormat,
          noteDirty: editor.noteDirty,
          tldrDirty: editor.tldrDirty,
          generating: editor.generating,
        })}
      </output>
      <button type="button" data-testid="type-note" onClick={() => editor.setNote('typed note')}>type</button>
      <button type="button" data-testid="type-tldr" onClick={() => editor.setTldr('typed tldr')}>type tldr</button>
      <button type="button" data-testid="clear-tldr" onClick={() => editor.setTldr('')}>clear tldr</button>
      <button type="button" data-testid="save-note" onClick={editor.saveNote}>save note</button>
      <button type="button" data-testid="save-tldr" onClick={() => editor.saveTldr('user')}>save tldr</button>
      <button type="button" data-testid="gen" onClick={() => void editor.generateTldr()}>generate</button>
      <button type="button" data-testid="sync" onClick={() => editor.syncMeta({ note: 'ext', tldr: 'ext-t', tldrSource: 'ai', noteFormat: 'markdown', tldrFormat: 'markdown' })}>sync</button>
      <button type="button" data-testid="reset" onClick={() => editor.resetMeta({ note: 'ext', tldr: 'ext-t', tldrSource: 'ai' })}>reset</button>
    </div>
  )
}

function state() {
  return JSON.parse(document.querySelector('[data-testid="state"]')!.textContent!) as {
    note: string
    tldr: string
    tldrSource: string
    noteDirty: boolean
    tldrDirty: boolean
    generating: boolean
  }
}

function click(testid: string) {
  act(() => {
    ;(document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement).click()
  })
}

describe('useNoteTldrEditor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('seeds drafts from initial meta', () => {
    mountTree(<Harness persist={(p) => ({ ...initial, ...p })} generate={() => Promise.resolve('ai')} notify={() => {}} />)
    expect(state()).toMatchObject({ note: 'n0', tldr: 't0', tldrSource: 'user', noteDirty: false, tldrDirty: false })
  })

  it('preserves existing formats, defaults new text to markdown, and clears to plain', () => {
    const persisted: Array<Partial<NoteTldrMeta>> = []
    const mount = (meta: NoteTldrMeta) => mountTree(<Harness meta={meta} persist={(p) => { persisted.push(p); return { ...meta, ...p } }} generate={() => Promise.resolve('ai')} notify={() => {}} />)
    mount({ note: 'plain note', tldr: 'plain tldr', tldrSource: 'user', noteFormat: 'plain', tldrFormat: 'plain' })
    click('type-note'); click('save-note'); click('type-tldr'); click('save-tldr')
    expect(persisted.slice(-2)).toEqual([{ note: 'typed note', noteFormat: 'plain' }, { tldr: 'typed tldr', tldrSource: 'user', tldrFormat: 'plain' }])
    cleanup(); document.body.innerHTML = ''
    persisted.length = 0
    mount({ note: '', tldr: '', tldrSource: 'empty', noteFormat: 'plain', tldrFormat: 'plain' })
    click('type-note'); click('save-note'); click('type-tldr'); click('save-tldr')
    expect(persisted.slice(-2)).toEqual([{ note: 'typed note', noteFormat: 'markdown' }, { tldr: 'typed tldr', tldrSource: 'user', tldrFormat: 'markdown' }])
    cleanup(); document.body.innerHTML = ''
    persisted.length = 0
    mount({ note: 'n', tldr: 't', tldrSource: 'user', noteFormat: 'plain', tldrFormat: 'plain' })
    click('clear-tldr'); click('save-tldr')
    expect(persisted[0]).toMatchObject({ tldrFormat: 'plain' })
  })

  it('uses format received through syncMeta when saving', () => {
    const persisted: Array<Partial<NoteTldrMeta>> = []
    mountTree(<Harness persist={(p) => { persisted.push(p); return { ...initial, ...p } }} generate={() => Promise.resolve('ai')} notify={() => {}} />)
    click('sync'); click('type-note'); click('save-note')
    expect(persisted.at(-1)).toMatchObject({ noteFormat: 'markdown' })
  })

  it('typing marks dirty; saveNote persists trimmed and notifies with success tone', () => {
    const persisted: Array<Partial<NoteTldrMeta>> = []
    const notes: Array<[string, string]> = []
    mountTree(
      <Harness
        persist={(p) => {
          persisted.push(p)
          return { ...initial, ...p }
        }}
        generate={() => Promise.resolve('ai')}
        notify={(m, tone) => notes.push([m, tone])}
      />,
    )
    click('type-note')
    expect(state().noteDirty).toBe(true)
    click('save-note')
    expect(persisted).toEqual([{ note: 'typed note' }])
    expect(notes).toEqual([['Note saved', 'success']])
    expect(state()).toMatchObject({ note: 'typed note', noteDirty: false })
  })

  it('syncMeta keeps unsaved drafts but adopts clean fields', () => {
    mountTree(<Harness persist={(p) => ({ ...initial, ...p })} generate={() => Promise.resolve('ai')} notify={() => {}} />)
    click('type-note')
    click('sync')
    // note draft survives (dirty); tldr adopts external value (clean)
    expect(state()).toMatchObject({ note: 'typed note', tldr: 'ext-t', tldrSource: 'ai' })
  })

  it('resetMeta discards drafts', () => {
    mountTree(<Harness persist={(p) => ({ ...initial, ...p })} generate={() => Promise.resolve('ai')} notify={() => {}} />)
    click('type-note')
    click('reset')
    expect(state()).toMatchObject({ note: 'ext', noteDirty: false })
  })

  it('generateTldr persists the AI draft and clears dirty', async () => {
    const persisted: Array<Partial<NoteTldrMeta>> = []
    const notes: string[] = []
    mountTree(
      <Harness
        persist={(p) => {
          persisted.push(p)
          return { ...initial, ...p } as NoteTldrMeta
        }}
        generate={() => Promise.resolve('generated tl;dr')}
        notify={(m) => notes.push(m)}
      />,
    )
    click('type-tldr')
    await act(async () => {
      ;(document.querySelector('[data-testid="gen"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(persisted).toEqual([{ tldr: 'generated tl;dr', tldrSource: 'ai' }])
    expect(state()).toMatchObject({ tldr: 'generated tl;dr', tldrSource: 'ai', tldrDirty: false, generating: false })
    expect(notes).toEqual(['TL;DR generated · you can edit it'])
  })

  it('saveTldr with empty text stores empty source', () => {
    const persisted: Array<Partial<NoteTldrMeta>> = []
    const notes: string[] = []
    mountTree(
      <Harness
        meta={{ note: '', tldr: '', tldrSource: 'empty' }}
        persist={(p) => {
          persisted.push(p)
          return { note: '', tldr: '', tldrSource: 'empty', ...p }
        }}
        generate={() => Promise.resolve('ai')}
        notify={(m) => notes.push(m)}
      />,
    )
    click('save-tldr')
    expect(persisted).toEqual([{ tldr: '', tldrSource: 'empty' }])
    expect(notes).toEqual(['TL;DR cleared'])
  })

  it('double-generate is guarded while in flight', async () => {
    let resolveGen: (v: string) => void = () => {}
    const genCalls: number[] = []
    mountTree(
      <Harness
        persist={(p) => ({ ...initial, ...p })}
        generate={() => {
          genCalls.push(1)
          return new Promise<string>((r) => {
            resolveGen = r
          })
        }}
        notify={() => {}}
      />,
    )
    act(() => {
      ;(document.querySelector('[data-testid="gen"]') as HTMLButtonElement).click()
      ;(document.querySelector('[data-testid="gen"]') as HTMLButtonElement).click()
    })
    expect(genCalls.length).toBe(1)
    await act(async () => {
      resolveGen('done')
      await Promise.resolve()
    })
    expect(state().generating).toBe(false)
  })
})
