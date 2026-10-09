import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import {
  buildCollectionOgCard,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  type CollectionOgCardInput,
} from './og-card.js';
import { loadOgBrandAssets, ogResvgFontFiles, ogSatoriFonts } from './og-fonts.js';

/**
 * satori → SVG → resvg → PNG for one collection card, behind a small
 * in-process cache (D1). Rasterizing costs tens of milliseconds of CPU; the
 * same card is re-requested by every crawler and chat preview, so PNGs are
 * memoized by content key (slug + updatedAt — the same pair that versions
 * the og:image URL). The map is size-bounded with FIFO eviction: OG cards
 * are re-renderable at any time, so nothing here needs to survive restart.
 */
export const OG_PNG_CACHE_MAX_ENTRIES = 200;

export interface CollectionOgImageInput extends CollectionOgCardInput {
  /** Cache discriminator — the public slug the card is served for. */
  readonly slug: string;
}

export interface CollectionOgImageRenderer {
  render(input: CollectionOgImageInput): Promise<Buffer>;
  readonly size: number;
}

export function ogImageCacheKey(input: CollectionOgImageInput): string {
  // Owner publication restrictions can change without touching the
  // collection's updatedAt.  Include every rendered public field so a card
  // generated before a restriction is never reused after the curator falls
  // back to the neutral identity.
  return JSON.stringify([
    input.slug,
    input.updatedAt,
    input.title,
    input.curator,
    input.itemCount,
  ]);
}

export function createCollectionOgImageRenderer(options?: {
  readonly maxEntries?: number;
}): CollectionOgImageRenderer {
  const maxEntries = options?.maxEntries ?? OG_PNG_CACHE_MAX_ENTRIES;
  const cache = new Map<string, Buffer>();
  const inflight = new Map<string, Promise<Buffer>>();
  return {
    get size() {
      return cache.size;
    },
    async render(input) {
      const key = ogImageCacheKey(input);
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;
      const render = (async () => {
        const assets = loadOgBrandAssets();
        const card = buildCollectionOgCard(input, assets.brandMarkSvg);
        const svg = await satori(card as Parameters<typeof satori>[0], {
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          fonts: ogSatoriFonts(assets),
        });
        const png = new Resvg(svg, {
          fitTo: { mode: 'width', value: OG_IMAGE_WIDTH },
          font: { loadSystemFonts: false, fontFiles: [...ogResvgFontFiles()] },
          background: '#f3f5f8',
        }).render().asPng();
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, png);
        return png;
      })();
      inflight.set(key, render);
      try {
        return await render;
      } finally {
        inflight.delete(key);
      }
    },
  };
}
