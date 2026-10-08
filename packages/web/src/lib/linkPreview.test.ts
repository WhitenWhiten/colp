import { describe, expect, it } from 'vitest'
import { previewCover } from './linkPreview'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('previewCover', () => {
  it('accepts the product link-preview object with integer sides', () => {
    expect(previewCover({ url: `https://known.example/api/v1/link-preview/${ID}`, width: 1200, height: 630 }))
      .toEqual({ url: `https://known.example/api/v1/link-preview/${ID}`, width: 1200, height: 630 })
  })

  it.each([
    null,
    'string',
    { url: `https://known.example/api/v1/favicon/${ID}`, width: 10, height: 10 },
    { url: 'https://cdn.example.com/og.png', width: 10, height: 10 },
    { url: `http://known.example/api/v1/link-preview/${ID}`, width: 10, height: 10 },
    { url: `https://u:p@known.example/api/v1/link-preview/${ID}`, width: 10, height: 10 },
    { url: `https://known.example/api/v1/link-preview/${ID}?x=1`, width: 10, height: 10 },
    { url: `https://known.example/api/v1/link-preview/${ID}`, width: 0, height: 10 },
    { url: `https://known.example/api/v1/link-preview/${ID}`, width: 10.5, height: 10 },
    { url: `https://known.example/api/v1/link-preview/${ID}`, width: 10, height: 5000 },
  ])('rejects %j', (value) => {
    expect(previewCover(value)).toBeNull()
  })
})
