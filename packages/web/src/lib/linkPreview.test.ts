import { describe, expect, it } from 'vitest'
import { folderGalleryCovers, nodeGalleryCover, previewCover } from './linkPreview'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('previewCover', () => {
  it('accepts the product link-preview object with integer sides', () => {
    expect(previewCover({ url: `https://known.example/api/v1/link-preview/${ID}`, width: 1200, height: 630 }))
      .toEqual({ url: `https://known.example/api/v1/link-preview/${ID}`, width: 1200, height: 630 })
  })

  it('accepts immutable uploaded covers and keeps folder choices above automatic mosaics', () => {
    const custom = { url: `https://known.example/api/v1/images/${ID}`, width: 1000, height: 500 }
    const automatic = [{ ...custom, url: `https://known.example/api/v1/link-preview/${ID}` }]
    expect(previewCover(custom)).toEqual(custom)
    expect(folderGalleryCovers({ coverMode: 'custom', coverImage: custom }, automatic)).toEqual([custom])
    expect(folderGalleryCovers({ coverMode: 'none' }, automatic)).toEqual([])
    expect(folderGalleryCovers({ coverMode: 'custom', coverImage: null }, automatic)).toEqual([])
    expect(folderGalleryCovers({ coverMode: 'auto' }, automatic)).toBe(automatic)
    expect(folderGalleryCovers({}, automatic)).toBe(automatic)
    expect(nodeGalleryCover({ coverImage: custom, previewImage: automatic[0] })).toEqual(custom)
    expect(nodeGalleryCover({ coverImage: null, previewImage: automatic[0] })).toBeNull()
    expect(nodeGalleryCover({ previewImage: automatic[0] })).toEqual(automatic[0])
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
