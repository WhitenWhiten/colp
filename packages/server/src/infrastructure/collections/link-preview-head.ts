/**
 * LP-02 link preview head adapter: parse fetched HTML with linkedom, read
 * every `<meta>` and `<link>` fact, and hand them to the pure candidate
 * selection. No network. A `<base href>` re-roots relative references the
 * way a browser would; the final hop URL is the fallback base.
 */
import { parseHTML } from 'linkedom';
import {
  resolvePreviewImageUrl,
  selectPreviewCandidates,
  type LinkPreviewCandidate,
  type LinkPreviewHeadTag,
} from '../../modules/collections/index.js';

type AttributeElement = { getAttribute(name: string): string | null };

export function extractPreviewCandidates(html: string, finalUrl: string): LinkPreviewCandidate[] {
  const { document } = parseHTML(html);
  const baseHref = (document.querySelector('base[href]') as AttributeElement | null)?.getAttribute('href');
  const baseUrl = (baseHref ? resolvePreviewImageUrl(baseHref, finalUrl) : null) ?? finalUrl;
  const tags: LinkPreviewHeadTag[] = [];
  for (const element of Array.from(document.querySelectorAll('meta, link')) as Array<AttributeElement & { localName: string }>) {
    if (element.localName === 'meta') {
      const key = element.getAttribute('property') ?? element.getAttribute('name');
      const content = element.getAttribute('content');
      if (key !== null && content !== null) tags.push({ kind: 'meta', key, content });
    } else {
      const rel = element.getAttribute('rel');
      const href = element.getAttribute('href');
      if (rel !== null && href !== null) tags.push({ kind: 'link', rel, href });
    }
  }
  return selectPreviewCandidates(tags, baseUrl);
}
