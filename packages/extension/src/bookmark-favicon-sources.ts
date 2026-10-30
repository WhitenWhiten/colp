import { allSites } from './site-adapters/registry.js';

/** Local resources only: rendering bookmarks must not contact their websites. */
export function bookmarkFaviconSources(pageUrl: string): readonly string[] {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return []; }
  if (!['http:', 'https:'].includes(page.protocol)) return [];
  const cached = (url: string) => {
    const resource = new URL(chrome.runtime.getURL('/_favicon/'));
    resource.searchParams.set('pageUrl', url);
    resource.searchParams.set('size', '32');
    return resource.toString();
  };
  const site = allSites().find(site => site.origin === page.origin);
  const mark = site?.icon;
  const authored = mark?.kind === 'asset' ? chrome.runtime.getURL(mark.path)
    : mark?.kind === 'data' ? mark.dataUrl : undefined;
  // Chrome can return a successful generic image for a cache miss, so an
  // authored site mark must precede that resource, rather than rely on onerror.
  return [...(authored ? [authored] : []), ...(site ? [cached(`${page.origin}/`)] : []), cached(pageUrl)];
}
