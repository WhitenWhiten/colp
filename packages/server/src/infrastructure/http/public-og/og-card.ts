import {
  PUBLIC_SHELL_TITLE_MAX,
  sanitizePublicShellText,
} from '../public-shell/sanitize-public-shell-text.js';
import { FALLBACK_CURATOR } from '../public-shell/inject-collection-shell.js';

/**
 * Per-collection OG card (D1): 1200×630, paper #f3f5f8 with a 26px dot
 * dither, brand mark + Know-N wordmark on top, with the collection title and
 * one info line below. (The site-wide og-cover.png is a separate, richer
 * still of the landing hero; see Known-Frontend/web/scripts/generate-og-cover.mjs.)
 *
 * Built as a satori VDOM tree (plain objects, no JSX — this package compiles
 * without a JSX transform). Text nodes are never HTML-parsed, so collection
 * copy is injection-safe by construction; sanitizePublicShellText still
 * bounds it to the same contract as the stamped HTML shell.
 */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Cards wrap poorly past this; the HTML shell allows 300. */
export const OG_CARD_TITLE_MAX = 140;
export const OG_CARD_CURATOR_MAX = 60;

const INK = '#06070a';
const MUTED = '#616367';
const PAPER = '#f3f5f8';
/** Canvas dot dither: 1.2px dots on a 26px grid. */
const DITHER = 'radial-gradient(circle, rgba(6,7,10,0.055) 1.2px, transparent 1.2px)';

type VNode = {
  readonly type: string;
  readonly props: Record<string, unknown> & { readonly children?: unknown };
};

export interface CollectionOgCardInput {
  readonly title: string;
  readonly curator: string;
  readonly itemCount: number;
  readonly updatedAt: string;
}

export function formatOgUpdatedDate(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return updatedAt.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

export function buildCollectionOgCard(
  input: CollectionOgCardInput,
  brandMarkSvg: string,
): VNode {
  const title = sanitizePublicShellText(input.title, OG_CARD_TITLE_MAX);
  const curator = sanitizePublicShellText(input.curator, OG_CARD_CURATOR_MAX) || FALLBACK_CURATOR;
  const count = Math.max(0, Math.trunc(input.itemCount));
  const meta = `Curated by ${curator} · ${count} ${count === 1 ? 'item' : 'items'} · updated ${formatOgUpdatedDate(input.updatedAt)}`;
  const markSrc = `data:image/svg+xml;base64,${Buffer.from(brandMarkSvg, 'utf8').toString('base64')}`;

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        padding: '72px 84px',
        backgroundColor: PAPER,
        backgroundImage: DITHER,
        backgroundSize: '26px 26px',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', gap: 24 },
            children: [
              { type: 'img', props: { src: markSrc, width: 68, height: 68 } },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    fontFamily: 'Instrument Sans',
                    fontWeight: 600,
                    fontSize: 40,
                    letterSpacing: '-0.03em',
                    color: INK,
                  },
                  children: [
                    { type: 'span', props: { children: 'Know-' } },
                    {
                      type: 'span',
                      props: {
                        style: {
                          fontFamily: 'Newsreader',
                          fontStyle: 'italic',
                          fontWeight: 700,
                          fontSize: 46,
                          marginLeft: -1,
                        },
                        children: 'N',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        { type: 'div', props: { style: { display: 'flex', flexGrow: 1 } } },
        {
          type: 'div',
          props: {
            style: {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
              overflow: 'hidden',
              fontFamily: 'Instrument Sans',
              fontWeight: 700,
              fontSize: 66,
              lineHeight: 1.14,
              letterSpacing: '-0.02em',
              color: INK,
            },
            children: title,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              marginTop: 28,
              fontFamily: 'Instrument Sans',
              fontWeight: 400,
              fontSize: 29,
              color: MUTED,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            children: meta,
          },
        },
      ],
    },
  };
}
