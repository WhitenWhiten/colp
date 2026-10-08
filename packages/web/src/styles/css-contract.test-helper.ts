import { flattenAllLayeredCssForHappyDom, readStyle } from './dashboard-stack-cascade.test-helper'

/**
 * Computed-style harness for CSS contract tests.
 *
 * Text assertions against a stylesheet (`body` matches `/overflow-wrap:
 * anywhere/`) break when a rule is renamed or re-homed and stay green when a
 * later layer silently overrides it. These helpers instead mount the real
 * files (flattened with layer compensation, see dashboard-stack-cascade),
 * build the element the selector describes, and read `getComputedStyle`.
 *
 * happy-dom limits: `@layer` is emulated by the flattener, `@media` is not
 * evaluated against a viewport (so only base rules are observable),
 * `color-mix()` / gradients / container queries do not compute. Assert on
 * layout and text properties (display, flex-*, overflow*, white-space,
 * text-overflow, min-*), not on colours.
 */

const STYLE_ID = 'css-contract-computed'

/** Tokens the mounted rules read; enough for lengths to resolve. */
const TOKEN_STUB = `:root {
  --shell: 90rem; --shell-grid: 96rem; --measure: 38rem; --measure-wide: 46rem;
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.25rem; --space-6: 1.5rem;
  --hair-15: 0.15rem; --hair-30: 0.3rem; --hair-35: 0.35rem; --hair-40: 0.4rem;
  --hair-45: 0.45rem; --hair-55: 0.55rem; --hair-65: 0.65rem; --hair-70: 0.7rem;
  --hair-85: 0.85rem; --hair-90: 0.9rem; --hair-110: 1.1rem; --hair-125: 1.25rem;
  --hair-150: 1.5rem; --hair-160: 1.6rem; --hair-200: 2rem;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-md: 1rem; --text-lg: 1.125rem;
  --radius: 8px; --line: #ddd; --ink: #000; --paper: #fff; --surface: #fff;
}`

export function mountCascade(files: readonly string[], doc: Document = document): void {
  doc.getElementById(STYLE_ID)?.remove()
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `${TOKEN_STUB}\n${flattenAllLayeredCssForHappyDom(files.map((file) => readStyle(file)))}`
  doc.head.appendChild(style)
}

export function unmountCascade(doc: Document = document): void {
  doc.getElementById(STYLE_ID)?.remove()
  doc.body.innerHTML = ''
}

type Compound = { tag: string; classes: string[]; attrs: Array<[string, string | null]>; child: boolean }

/** `.a > .b[data-x] h1.c` → chain of compounds. Pseudo-classes are not supported. */
function parseSelectorPath(selector: string): Compound[] {
  const tokens = selector.trim().split(/\s+/)
  const chain: Compound[] = []
  let childNext = false
  for (const token of tokens) {
    if (token === '>') { childNext = true; continue }
    let rest = token
    const compound: Compound = { tag: 'div', classes: [], attrs: [], child: childNext }
    childNext = false
    const tag = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/)
    if (tag) { compound.tag = tag[0]; rest = rest.slice(tag[0].length) }
    for (const part of rest.matchAll(/\.([_a-zA-Z0-9-]+)|\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
      if (part[1]) compound.classes.push(part[1])
      else if (part[2]) compound.attrs.push([part[2], part[3] ?? part[4] ?? part[5] ?? null])
    }
    chain.push(compound)
  }
  return chain
}

/**
 * Builds the DOM the selector describes (descendants nested one level per
 * compound) under `document.body` and returns the innermost element.
 */
export function buildElement(selector: string, doc: Document = document): HTMLElement {
  let parent: HTMLElement = doc.body
  let leaf: HTMLElement = parent
  for (const compound of parseSelectorPath(selector)) {
    const el = doc.createElement(compound.tag)
    for (const cls of compound.classes) el.classList.add(cls)
    for (const [name, value] of compound.attrs) el.setAttribute(name, value ?? '')
    parent.appendChild(el)
    parent = el
    leaf = el
  }
  return leaf
}

/** Computed style of the element `selector` describes, after mounting `files`. */
export function computedFor(selector: string, files: readonly string[], doc: Document = document): CSSStyleDeclaration {
  mountCascade(files, doc)
  const el = buildElement(selector, doc)
  return getComputedStyle(el)
}

/** `getPropertyValue` with the camelCase fallback happy-dom sometimes needs. */
export function prop(style: CSSStyleDeclaration, name: string): string {
  const direct = style.getPropertyValue(name)
  if (direct) return direct
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof CSSStyleDeclaration
  const value = style[camel]
  return typeof value === 'string' ? value : ''
}
