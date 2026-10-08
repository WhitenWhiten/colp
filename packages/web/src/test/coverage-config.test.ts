import { describe, expect, it } from 'vitest'
import config from '../../vitest.config'

describe('Frontend production coverage gate', () => {
  it('measures the complete source inventory and retains critical per-file floors', () => {
    const coverage = (config as {
      test?: {
        coverage?: {
          all?: boolean
          reporter?: string[]
          include?: string[]
          exclude?: string[]
          thresholds?: Record<string, unknown>
        }
      }
    }).test?.coverage

    expect(coverage?.all).toBe(true)
    expect(coverage?.reporter).toContain('text-summary')
    expect(coverage?.include).toEqual(['src/**/*.{ts,tsx}'])
    expect(coverage?.exclude).toEqual(expect.arrayContaining([
      'src/**/*.test.{ts,tsx}',
      'src/test/**',
      'src/**/*.d.ts',
    ]))
    expect(coverage?.thresholds).toMatchObject({
      statements: 81,
      branches: 80,
      functions: 71,
      lines: 81,
      'src/components/VirtualList.tsx': expect.any(Object),
      'src/components/canvas-board/interaction.ts': expect.any(Object),
      'src/components/canvas-board/persistence.ts': expect.any(Object),
      'src/lib/useAutoSaveDraft.ts': expect.any(Object),
      'src/pages/CollectionEditor.tsx': expect.any(Object),
      'src/pages/Feed.tsx': expect.any(Object),
      'src/pages/Profile.tsx': expect.any(Object),
    })
  })
})
