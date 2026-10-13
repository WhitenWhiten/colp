import { describe, expect, it } from 'vitest'
import config from '../../vitest.config'

describe('Frontend production coverage gate', () => {
  it('measures the complete source inventory and retains critical per-file floors', () => {
    const coverage = (config as {
      test?: {
        coverage?: {
          reporter?: string[]
          include?: string[]
          exclude?: string[]
          thresholds?: Record<string, unknown>
        }
      }
    }).test?.coverage

    expect(coverage?.reporter).toContain('text-summary')
    expect(coverage?.include).toEqual(['src/**/*.{ts,tsx}'])
    expect(coverage?.exclude).toEqual(expect.arrayContaining([
      'src/**/*.test.{ts,tsx}',
      'src/test/**',
      'src/**/*.d.ts',
    ]))
    expect(coverage?.thresholds).toMatchObject({
      statements: 81,
      branches: 75.8,
      functions: 71,
      lines: 81,
      'src/components/VirtualList.tsx': expect.any(Object),
      'src/lib/useAutoSaveDraft.ts': expect.any(Object),
      'src/pages/CollectionEditor.tsx': expect.any(Object),
    })
  })
})
