import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OG-card brand assets (D1). Fonts are static OFL instances — satori cannot
 * parse variable fonts or woff2, so these are vendored TTF/OTF files:
 *   - Instrument Sans (latin brand text; same family as the web UI)
 *   - Newsreader 16pt Bold Italic (the wordmark's italic N)
 *   - Noto Sans SC (CJK collection titles; satori falls back to it per glyph)
 * The brand mark is a byte copy of Known-Frontend/web/public/favicon.svg so the
 * card can never drift from the site icon; og-brand-assets.test.ts pins that.
 *
 * Resolved from the repo root so tsx sources (vitest) and compiled dist/src
 * output land on the same directory: <root>/assets/og.
 */
const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../assets/og');
const FONTS_DIR = resolve(ASSETS_DIR, 'fonts');

const FONT_FILES = {
  instrumentSansRegular: 'InstrumentSans-Regular.ttf',
  instrumentSansSemiBold: 'InstrumentSans-SemiBold.ttf',
  instrumentSansBold: 'InstrumentSans-Bold.ttf',
  newsreaderBoldItalic: 'Newsreader16pt-BoldItalic.ttf',
  notoSansScRegular: 'NotoSansSC-Regular.otf',
  notoSansScBold: 'NotoSansSC-Bold.otf',
} as const;

export interface OgBrandAssets {
  readonly instrumentSansRegular: Buffer;
  readonly instrumentSansSemiBold: Buffer;
  readonly instrumentSansBold: Buffer;
  readonly newsreaderBoldItalic: Buffer;
  readonly notoSansScRegular: Buffer;
  readonly notoSansScBold: Buffer;
  /** Raw SVG markup of the brand mark (favicon glyph). */
  readonly brandMarkSvg: string;
}

let cached: OgBrandAssets | null = null;

export function loadOgBrandAssets(): OgBrandAssets {
  if (cached !== null) return cached;
  const read = (name: keyof typeof FONT_FILES): Buffer => readFileSync(resolve(FONTS_DIR, FONT_FILES[name]));
  cached = Object.freeze({
    instrumentSansRegular: read('instrumentSansRegular'),
    instrumentSansSemiBold: read('instrumentSansSemiBold'),
    instrumentSansBold: read('instrumentSansBold'),
    newsreaderBoldItalic: read('newsreaderBoldItalic'),
    notoSansScRegular: read('notoSansScRegular'),
    notoSansScBold: read('notoSansScBold'),
    brandMarkSvg: readFileSync(resolve(ASSETS_DIR, 'brand-mark.svg'), 'utf8'),
  });
  return cached;
}

/**
 * resvg rasterizes the satori SVG against the same font set, by path (the
 * documented node API — fontBuffers is wasm-only). System fonts stay off so
 * the card is byte-stable across containers (the alpine runtime has none).
 */
export function ogResvgFontFiles(): readonly string[] {
  return Object.values(FONT_FILES).map((name) => resolve(FONTS_DIR, name));
}

/** satori font table: latin first, CJK as the per-glyph fallback. */
export function ogSatoriFonts(assets: OgBrandAssets): {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: 'normal' | 'italic';
}[] {
  return [
    { name: 'Instrument Sans', data: assets.instrumentSansRegular, weight: 400, style: 'normal' },
    { name: 'Instrument Sans', data: assets.instrumentSansSemiBold, weight: 600, style: 'normal' },
    { name: 'Instrument Sans', data: assets.instrumentSansBold, weight: 700, style: 'normal' },
    { name: 'Newsreader', data: assets.newsreaderBoldItalic, weight: 700, style: 'italic' },
    { name: 'Noto Sans SC', data: assets.notoSansScRegular, weight: 400, style: 'normal' },
    { name: 'Noto Sans SC', data: assets.notoSansScBold, weight: 700, style: 'normal' },
  ];
}
