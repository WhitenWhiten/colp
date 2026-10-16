/**
 * Pane sub-pages.
 *
 * A page with several readings (Sync) owns a real tablist and shows one panel
 * at a time. The Account page has a sub-page (credits) without a tablist. The
 * router owns the hash, so every deep link keeps working; this module only
 * decides what is on screen.
 *
 * The rail itself is the site's `.view-switch` segmented control (chrome.css,
 * mirrored from design/shared-chrome.css).
 */
export type HubPane = 'bookmarks' | 'history' | 'subscriptions' | 'sync' | 'automations' | 'saving' | 'ai' | 'general' | 'account' | 'help';
export type SyncView = 'folders' | 'center' | 'import';
export type AccountView = 'session' | 'credits';
export type SubscriptionView = 'list' | 'new' | 'detail' | 'history';
/** `page` is the single surface of a pane with no sub-pages. */
export type HubView = SyncView | AccountView | SubscriptionView | 'page';

/** First entry is the pane's default view; the other panes are a single surface. */
export const paneViews: Readonly<Record<HubPane, readonly HubView[]>> = {
  bookmarks: [],
  history: [],
  subscriptions: ['list', 'new', 'detail', 'history'],
  sync: ['folders', 'center', 'import'],
  automations: [],
  saving: [],
  ai: [],
  general: [],
  account: ['session', 'credits'],
  help: [],
};

export function defaultView(pane: HubPane): HubView {
  return paneViews[pane][0] ?? 'page';
}

export function viewFor(pane: HubPane, raw: string | undefined): HubView {
  return raw !== undefined && (paneViews[pane] as readonly string[]).includes(raw)
    ? raw as HubView
    : defaultView(pane);
}

/** A pane with no sub-pages keeps its bare `#pane` hash; Account's default view is the bare page too. */
export function hubHash(pane: HubPane, view: HubView, suffix = ''): string {
  return paneViews[pane].length === 0 || pane === 'account' && view === 'session' ? `#${pane}${suffix}` : `#${pane}/${view}${suffix}`;
}

interface PaneTabs { readonly list: HTMLElement | undefined; readonly tabs: readonly HTMLButtonElement[]; readonly panels: readonly HTMLElement[] }

export interface HubTabs {
  apply(pane: HubPane, view: HubView): void;
  /** Narrows a pane's sub-pages — Credits only exists once an account is connected. */
  setAvailable(pane: HubPane, views: readonly HubView[]): void;
  currentView(pane: HubPane): HubView;
}

export function createHubTabs(navigate: (hash: string) => void): HubTabs {
  const groups = new Map<HubPane, PaneTabs>();
  const available = new Map<HubPane, readonly HubView[]>();
  const current = new Map<HubPane, HubView>();

  /* A pane's sub-pages are the `[data-view]` panels inside its `[data-view-pane]`
     element; the tablist, when it has one, is the `[data-tabs]` rail. */
  for (const scope of Array.from(document.querySelectorAll<HTMLElement>('[data-view-pane]'))) {
    const pane = scope.dataset.viewPane as HubPane;
    if (!(pane in paneViews)) continue;
    const list = scope.querySelector<HTMLElement>(`[data-tabs="${pane}"]`) ?? undefined;
    const tabs = Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="tab"][data-view]') ?? []);
    groups.set(pane, { list, tabs, panels: Array.from(scope.querySelectorAll<HTMLElement>('[data-view-panel]')) });
    for (const tab of tabs) {
      tab.addEventListener('click', () => navigate(hubHash(pane, tab.dataset.view as HubView)));
      tab.addEventListener('keydown', (event) => roam(pane, tab, event));
    }
  }

  /* Arrow/Home/End move between tabs the way the web TabList does, so the
     rail behaves like a tablist and not like four unrelated buttons. */
  function roam(pane: HubPane, tab: HTMLButtonElement, event: KeyboardEvent): void {
    const tabs = groups.get(pane)?.tabs.filter((candidate) => !candidate.hidden) ?? [];
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1 : -1;
    const target = next < 0 ? undefined : tabs[next];
    if (!target) return;
    event.preventDefault();
    target.focus();
    navigate(hubHash(pane, target.dataset.view as HubView));
  }

  function apply(pane: HubPane, view: HubView): void {
    const group = groups.get(pane);
    if (!group) return;
    const allowed = available.get(pane) ?? paneViews[pane];
    /* No reachable view means the pane is gated — Sync without an account —
       and every panel stays down so the gate card stands alone. */
    const active = allowed.length === 0 ? undefined : allowed.includes(view) ? view : defaultView(pane);
    if (active !== undefined) current.set(pane, active);
    for (const tab of group.tabs) {
      const selected = tab.dataset.view === active;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of group.panels) panel.hidden = panel.dataset.viewPanel !== active;
  }

  return {
    apply,
    currentView: (pane) => current.get(pane) ?? defaultView(pane),
    setAvailable(pane, views) {
      available.set(pane, views);
      const group = groups.get(pane);
      if (!group) return;
      for (const tab of group.tabs) tab.hidden = !views.includes(tab.dataset.view as HubView);
      // A rail with one reachable tab says nothing; the panel stands alone.
      if (group.list) group.list.hidden = views.length < 2;
      const active = current.get(pane) ?? defaultView(pane);
      if (views.length > 0 && !views.includes(active)) { navigate(hubHash(pane, defaultView(pane))); return; }
      apply(pane, active);
    },
  };
}
