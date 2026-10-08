import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Settings dialog layout contract.
 *
 * The page shell is no longer a width authority. The dialog token is the
 * only width, sections stay single-column, and the retired page-layout
 * machinery must not return.
 */

const stylesDir = resolve(import.meta.dirname)
const srcDir = resolve(import.meta.dirname, '..')
const appPath = resolve(srcDir, 'App.tsx')

/** Only ID selector the stylesheets are allowed to carry. */
const ALLOWED_ID_SELECTOR = '#root'

const RETIRED = new RegExp(
  [
    ['measure', 'form'].join('-'),
    ['settings', 'layout'].join('-'),
    ['settings', 'panel'].join('-'),
    ['@container', 'settings'].join(' '),
  ].join('|'),
  'g',
)

const SETTINGS_FORM_SOURCES = [
  'components/settings/ProfileSection.tsx',
  'components/auth/EmailChangeSection.tsx',
  'components/auth/PasswordChangeSection.tsx',
  'components/auth/ProviderLinkSection.tsx',
  'components/auth/AccountDeleteSection.tsx',
]

function readStyle(file: string): string {
  return readFileSync(resolve(stylesDir, file), 'utf8')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function ruleBlock(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stripComments(css).match(
    new RegExp(`(?:^|[,;{}\\n])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'm'),
  )
  return match?.[1] ?? null
}

function ruleHeaders(css: string): Array<{ header: string; block: string }> {
  const rules: Array<{ header: string; block: string }> = []
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const header = match[1]!.replace(/\s+/g, ' ').trim()
    if (!header || header.startsWith('@')) continue
    rules.push({ header, block: match[2] ?? '' })
  }
  return rules
}

function formClassNames(source: string): { classNames: string[]; tags: number } {
  return {
    classNames: [...source.matchAll(/<form\b[^>]*?className="([^"]*)"/g)].map((m) => m[1] ?? ''),
    tags: [...source.matchAll(/<form\b/g)].length,
  }
}

function collectFiles(directory: string, match: (name: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      files.push(...collectFiles(path, match))
    } else if (entry.isFile() && match(entry.name)) {
      files.push(path)
    }
  }
  return files
}

describe('settings dialog layout', () => {
  const tokens = readStyle('tokens.css')
  const studioCss = readStyle('studio.css')
  const authCss = readStyle('auth.css')

  it('declares the dialog width once as min(96vw, N rem)', () => {
    const declarations = [...stripComments(tokens).matchAll(/--settings-dialog-w:\s*([^;]+);/g)]
    expect(declarations).toHaveLength(1)
    expect(declarations[0]![1]!.trim()).toMatch(/^min\(\s*96vw,\s*\d+(\.\d+)?rem\s*\)$/)

    const others = readdirSync(stylesDir)
      .filter((file) => file.endsWith('.css') && file !== 'tokens.css')
      .filter((file) => /--settings-dialog-w:/.test(stripComments(readStyle(file))))
    expect(others, 'the dialog width is a token, not a per-page constant').toEqual([])
  })

  it('keeps deleted page-layout machinery out of styles and TSX', () => {
    const offenders: string[] = []
    const cssFiles = readdirSync(stylesDir).filter((file) => file.endsWith('.css'))
    for (const file of cssFiles) {
      const hits = readStyle(file).match(RETIRED)
      if (hits) offenders.push(`styles/${file}: ${[...new Set(hits)].join(', ')}`)
    }
    const tsxFiles = collectFiles(srcDir, (name) => name.endsWith('.tsx') || name.endsWith('.ts'))
    for (const file of tsxFiles) {
      if (file.endsWith('.contract.test.ts')) continue
      const source = readFileSync(file, 'utf8')
      const hits = source.match(RETIRED)
      if (hits) offenders.push(`${file.slice(srcDir.length + 1)}: ${[...new Set(hits)].join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps .settings-section as a single column with no grid-template-columns', () => {
    const layouts = ruleHeaders(studioCss).filter((rule) => {
      const selectors = rule.header.split(',').map((part) => part.trim())
      return selectors.includes('.settings-section')
    })
    expect(layouts.length).toBeGreaterThan(0)
    for (const rule of layouts) {
      expect(rule.block, rule.header).not.toMatch(/grid-template-columns/)
    }
  })

  it('does not mount Settings as a page in App.tsx', () => {
    const app = readFileSync(appPath, 'utf8')
    expect(app).not.toMatch(/element=\{<Settings\b/)
  })

  it('ends every settings column with its trailing action', () => {
    const saveBtn = ruleBlock(studioCss, '.settings-save-btn')
    expect(saveBtn).toMatch(/align-self:\s*flex-end/)
    expect(saveBtn, 'a submit under the first field reads as a stray control').not.toMatch(
      /align-self:\s*flex-start/,
    )

    const actionRow = ruleBlock(authCss, '.auth-action-row')
    expect(actionRow).toMatch(/justify-content:\s*flex-end/)
  })

  it('sizes no control through an ID selector', () => {
    const offenders: string[] = []
    for (const file of readdirSync(stylesDir).filter((f) => f.endsWith('.css'))) {
      for (const { header } of ruleHeaders(readStyle(file))) {
        for (const id of header.matchAll(/#[a-zA-Z][\w-]*/g)) {
          if (id[0] === ALLOWED_ID_SELECTOR) continue
          offenders.push(`${file}: ${header}`)
        }
      }
    }
    expect(offenders, 'pin widths on a class the JSX already carries').toEqual([])
  })

  it('marks every settings form with the settings-form hook', () => {
    const offenders: string[] = []
    for (const file of SETTINGS_FORM_SOURCES) {
      const { classNames, tags } = formClassNames(readFileSync(resolve(srcDir, file), 'utf8'))
      if (classNames.length !== tags) {
        offenders.push(`${file}: ${tags} form(s), ${classNames.length} with a leading className`)
        continue
      }
      for (const className of classNames) {
        if (!className.split(/\s+/).includes('settings-form')) {
          offenders.push(`${file}: <form className="${className}">`)
        }
      }
    }
    expect(offenders, 'settings forms must carry settings-form').toEqual([])
  })
})
