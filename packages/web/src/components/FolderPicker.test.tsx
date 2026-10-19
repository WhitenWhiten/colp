// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { FolderPicker, type FolderPickerOption } from './FolderPicker'

afterEach(cleanup)

const folders: FolderPickerOption[] = [
  { id: 'bar', title: 'Bookmarks bar', depth: 0 },
  { id: 'work', title: 'Work', depth: 1 },
  { id: 'reading', title: 'Reading', depth: 2 },
  { id: 'other', title: 'Other bookmarks', depth: 0 },
  { id: 'reading-2', title: 'Reading', depth: 1 },
]

function Harness({ recentIds = [] }: { recentIds?: string[] }) {
  const [value, setValue] = useState('reading')
  return <form><FolderPicker id="pick" folders={folders} value={value} onChange={setValue} recentIds={recentIds} /></form>
}

const toggle = () => document.getElementById('pick') as HTMLButtonElement
const options = () => [...document.querySelectorAll<HTMLButtonElement>('#pick-panel [role="option"]')]
const search = () => document.querySelector<HTMLInputElement>('#pick-panel input[type="search"]')!
function type(value: string) {
  const input = search()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(target: Element, name: string) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
}

test('names the chosen folder after its parents and lists the tree indented, the chosen row checked', () => {
  mountTree(<Harness />)
  expect(toggle().value).toBe('reading')
  expect(document.getElementById('pick-current')?.textContent).toBe('Bookmarks bar › Work ›Reading')
  act(() => toggle().click())
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(search())
  expect(options().map((row) => row.style.getPropertyValue('--depth'))).toEqual(['0', '1', '2', '0', '1'])
  expect(options().filter((row) => row.getAttribute('aria-selected') === 'true').map((row) => row.dataset.folderId)).toEqual(['reading'])
  // The chosen row is the one tab stop.
  expect(options().filter((row) => row.tabIndex === 0).map((row) => row.dataset.folderId)).toEqual(['reading'])
})

test('a search lists matches flat with their paths, and Enter takes the first without submitting', () => {
  let submitted = 0
  mountTree(<Harness />)
  document.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); submitted++ })
  act(() => toggle().click())
  type('read')
  expect(options().map((row) => row.textContent)).toEqual(['ReadingBookmarks bar › Work', 'ReadingOther bookmarks'])
  expect(options().every((row) => row.style.getPropertyValue('--depth') === '')).toBe(true)
  type('nothing')
  expect(document.querySelector('#pick-panel')?.textContent).toContain('No folders match.')
  type('other')
  key(search(), 'Enter')
  expect(submitted).toBe(0)
  expect(toggle().value).toBe('other')
  expect(document.getElementById('pick-panel')).toBeNull()
  expect(document.activeElement).toBe(toggle())
})

test('arrows roam the rows, Escape closes the panel alone, and a click picks', () => {
  let escapes = 0
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') escapes++ })
  mountTree(<Harness />)
  act(() => toggle().click())
  key(search(), 'ArrowDown')
  expect(document.activeElement).toBe(options()[0])
  key(options()[0]!, 'End')
  expect(document.activeElement).toBe(options()[4])
  key(options()[4]!, 'ArrowUp')
  expect(document.activeElement).toBe(options()[3])
  key(options()[3]!, 'Home')
  key(options()[0]!, 'ArrowUp')
  expect(document.activeElement).toBe(search())
  key(search(), 'Escape')
  // The dialog around the picker never sees this Escape.
  expect(escapes).toBe(0)
  expect(document.getElementById('pick-panel')).toBeNull()
  expect(document.activeElement).toBe(toggle())
  act(() => toggle().click())
  act(() => options().find((row) => row.dataset.folderId === 'work')!.click())
  expect(toggle().value).toBe('work')
})

test('recent folders lead in their own group until a search starts', () => {
  mountTree(<Harness recentIds={['other', 'gone', 'work']} />)
  act(() => toggle().click())
  const groups = [...document.querySelectorAll('#pick-panel [role="group"]')]
  expect(groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Recent', 'All folders'])
  expect([...groups[0]!.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((row) => row.dataset.folderId)).toEqual(['other', 'work'])
  type('work')
  expect(document.querySelectorAll('#pick-panel [role="group"]')).toHaveLength(0)
  expect(options().map((row) => row.dataset.folderId)).toEqual(['work'])
})

test('a pointer press outside closes the panel', () => {
  mountTree(<><Harness /><button type="button" id="outside">Elsewhere</button></>)
  act(() => toggle().click())
  act(() => { document.getElementById('outside')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.getElementById('pick-panel')).toBeNull()
})
