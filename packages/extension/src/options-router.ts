import { isNativeWaitDeepLink, NATIVE_WAIT_ANCHOR } from './native-wait-ui.js';
import { PREFERENCE_SECTIONS } from './preferences-navigation.js';
import { BOOKMARK_SECTIONS, revealBookmarkSection } from './bookmarks-navigation.js';
import {
  createHubTabs, defaultView, hubHash, viewFor,
  type HubPane, type HubTabs, type HubView,
} from './options-tabs.js';
export type { AccountView, HubPane, HubView, SyncView } from './options-tabs.js';
export { paneViews } from './options-tabs.js';
/** Pre-merge pane names that now live inside the current panes. */
export type LegacyHubPane = 'folders' | 'import' | 'credits' | 'sync-center';
export interface HubRoute { readonly pane: HubPane; readonly view: HubView; readonly params: URLSearchParams; readonly hash: string; readonly anchor?: string }
const panes = new Set<HubPane>(['bookmarks', 'history', 'subscriptions', 'sync', 'automations', 'saving', 'ai', 'general', 'account', 'help']);
/* Where each retired pane landed. They are page selections now, not scroll
   targets, so a stale deep link opens the right page instead of dropping
   the reader halfway down a merged one. */
const legacyPanes: Readonly<Record<LegacyHubPane, { pane: HubPane; view: HubView }>> = {
  folders: { pane: 'sync', view: 'folders' },
  import: { pane: 'sync', view: 'import' },
  credits: { pane: 'account', view: 'credits' },
  'sync-center': { pane: 'sync', view: 'center' },
};
const RETURN_TARGET = /^(?:(?:saving|capture)\/(?:overview|history|settings|diagnostics)|subscriptions\/(?:list|new|detail|history)|account\/(?:session|credits)|sync\/(?:folders|center|import)|history|automations|saving|ai|general|help|bookmarks|account|preferences|diagnostics)(?:\?[A-Za-z0-9._~%=&+-]*)?$/u;
function readParams(search: string, pane?: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (['task', 'batch', 'chargeId', 'runId', 'mapping', 'event', 'draft'].includes(key) && /^[0-9a-f-]{36}$/u.test(value)) params.set(key, value);
    else if (['native', 'node', 'collection', 'item'].includes(key) && /^[A-Za-z0-9._~-]{1,128}$/u.test(value)) params.set(key, value);
    else if (['status', 'source', 'days', 'q', 'timezone', 'devices'].includes(key) && value.length <= 100 && !/[\u0000-\u001f]/u.test(value)) params.set(key, value);
    else if (key === 'section' && Object.hasOwn(pane === 'bookmarks' ? BOOKMARK_SECTIONS : PREFERENCE_SECTIONS, value)) params.set(key, value);
    else if (key === 'category' && ['all', 'capture', 'subscriptions', 'sync', 'permissions'].includes(value)) params.set(key, value);
    else if (key === 'day' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) params.set(key, value);
    else if (key === 'return' && value.length <= 512 && RETURN_TARGET.test(value)) params.set(key, value);
  }
  return params;
}
function landing(pane: HubPane, requested: HubView, params: URLSearchParams): HubRoute {
  const view = viewFor(pane, requested), suffix = params.size ? `?${params.toString()}` : '';
  return { pane, view, params, hash: hubHash(pane, view, suffix) };
}
/** Old hashes (Preferences, Diagnostics, the Saving tabs) land on the page that owns their content. */
function redirect(rawPane: string, rawView: string | undefined, params: URLSearchParams): HubRoute | undefined {
  if (rawPane === 'saving' || rawPane === 'capture') {
    if (rawView === 'diagnostics') { params.set('category', 'capture'); return landing('help', 'page', params); }
    // `#saving` itself is the settings page now; `#capture` and the Saving tabs were the history.
    const history = rawView === 'overview' || rawView === 'history' || rawPane === 'capture' && rawView !== 'settings';
    return landing(history ? 'history' : 'saving', 'page', params);
  }
  if (rawPane === 'preferences') {
    const section = params.get('section') as keyof typeof PREFERENCE_SECTIONS | null;
    params.delete('section');
    return landing(section ? PREFERENCE_SECTIONS[section] : 'saving', 'page', params);
  }
  if (rawPane === 'diagnostics') return landing('help', 'page', params);
  return undefined;
}
export function parseHubRoute(hash: string): HubRoute {
  /* The confirmation deep link keeps its literal hash: native-wait-ui reads
     `location.hash` directly to decide whether it was opened by a link. */
  if (isNativeWaitDeepLink(hash)) {
    return { pane: 'sync', view: 'center', params: new URLSearchParams(), hash: hash.startsWith('#') ? hash : `#${hash}`, anchor: NATIVE_WAIT_ANCHOR };
  }
  const [path = '', search = ''] = hash.replace(/^#/u, '').split('?', 2);
  const [rawPane = '', rawView] = path.split('/');
  const params = readParams(search, rawPane);
  const moved = redirect(rawPane, rawView, params);
  if (moved) return moved;
  if (panes.has(rawPane as HubPane)) {
    const pane = rawPane as HubPane;
    return landing(pane, viewFor(pane, rawView), params);
  }
  const legacy = legacyPanes[rawPane as LegacyHubPane];
  if (legacy) return landing(legacy.pane, legacy.view, params);
  return landing('bookmarks', defaultView('bookmarks'), params);
}

function scrollToAnchor(anchor: string | undefined): void {
  if (!anchor) return;
  document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
}

export function createOptionsRouter(elements: Record<HubPane, HTMLElement>, enter: (route: HubRoute) => void, identityChanged: () => void = () => undefined) {
  const memory = new Map<string, { x: number; y: number; main: number; focus: string | null }>();
  let current: HubRoute | undefined, identity = '', generation = 0;
  const explicitAtOpen = Boolean(location.hash);
  const main = document.querySelector<HTMLElement>('.main');
  const tabs: HubTabs = createHubTabs((hash) => navigate(hash));
  function remember() {
    if (!current) return;
    memory.set(current.hash, { x: scrollX, y: scrollY, main: main?.scrollTop ?? 0, focus: document.activeElement?.id || null });
    if (memory.size > 100) memory.delete(memory.keys().next().value!);
  }
  function render(route: HubRoute, restore: boolean) {
    const sameView = current?.pane === route.pane && current.view === route.view;
    if (current?.hash === route.hash) { tabs.apply(route.pane, route.view); revealBookmarkSection(route); scrollToAnchor(route.anchor); return; }
    remember(); current = route;
    for (const [id, element] of Object.entries(elements)) element.hidden = id !== route.pane;
    for (const link of Array.from(document.querySelectorAll<HTMLElement>('[data-step]'))) {
      if (link.dataset.step === route.pane) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    document.body.dataset.pane = route.pane;
    document.body.dataset.view = route.view;
    tabs.apply(route.pane, route.view);
    enter(route);
    revealBookmarkSection(route);
    const saved = memory.get(route.hash), heading = elements[route.pane].querySelector<HTMLElement>('h1');
    /* Focus moves to the page title so a screen reader announces the new
       surface. It is never reachable by Tab, so the ink focus ring chrome.css
       draws on :focus-visible would be decoration on a non-interactive
       target — `data-router-focus` opts it out (options.css). */
    if (heading) { heading.tabIndex = -1; heading.dataset.routerFocus = ''; }
    if (restore) {
      const focus = saved?.focus ? document.getElementById(saved.focus) : null;
      // Switching sub-pages must not yank focus back to the title.
      const target = focus && elements[route.pane].contains(focus) && !focus.hidden ? focus : sameView ? null : heading;
      target?.focus({ preventScroll: true });
      if (main) main.scrollTop = saved?.main ?? 0;
      window.scrollTo(saved?.x ?? 0, saved?.y ?? 0);
      scrollToAnchor(route.anchor);
    }
    void chrome.runtime.sendMessage({ kind: 'known.capture.navigation.set', hash: route.hash }).catch(() => undefined);
  }
  function navigate(hash: string, replace = false) {
    const route = parseHubRoute(hash);
    if (route.hash !== location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', route.hash);
    render(route, !replace);
  }
  const changed = () => {
    const route = parseHubRoute(location.hash);
    if (route.hash !== location.hash) history.replaceState(null, '', route.hash);
    render(route, true);
  };
  window.addEventListener('hashchange', changed); window.addEventListener('popstate', changed);
  return {
    explicitAtOpen,
    current: () => current ?? parseHubRoute(location.hash),
    navigate,
    paneFromHash: () => parseHubRoute(location.hash).pane,
    currentView: (pane: HubPane) => tabs.currentView(pane),
    setPaneViews: (pane: HubPane, views: readonly HubView[]) => { tabs.setAvailable(pane, views); },
    showPane(pane: HubPane | LegacyHubPane) {
      const legacy = legacyPanes[pane as LegacyHubPane];
      if (!legacy) { navigate(current?.pane === pane ? current.hash : hubHash(pane as HubPane, defaultView(pane as HubPane))); return; }
      navigate(hubHash(legacy.pane, legacy.view));
    },
    async initialize() {
      const version = ++generation, hash = location.hash;
      const response = await chrome.runtime.sendMessage({ kind: 'known.capture.navigation.get' }).catch(() => null) as { ok?: boolean; hash?: string; identity?: string } | null;
      if (version !== generation) return;
      identity = response?.identity ?? '';
      navigate(location.hash !== hash || hash ? location.hash : response?.hash ?? hubHash('bookmarks', defaultView('bookmarks')), true);
    },
    async refreshIdentity() {
      const version = ++generation;
      const response = await chrome.runtime.sendMessage({ kind: 'known.capture.navigation.get' }).catch(() => null) as { ok?: boolean; identity?: string } | null;
      if (version !== generation || !response?.ok || response.identity === identity) return;
      identity = response.identity ?? ''; memory.clear(); current = undefined; identityChanged(); render(parseHubRoute(location.hash), false);
    },
    returnAfterLogin() {
      const target = parseHubRoute(location.hash).params.get('return'); if (target) navigate(`#${target}`);
    },
  };
}
