import { bundledSites, legacySite, siteDefinition, type SiteDefinition } from './registry.js';
import { createSiteMark } from './site-icon.js';
import { t } from '../i18n.js';
export const selectedSite = siteDefinition(new URL(location.href).searchParams.get('adapterId') ?? legacySite.adapterId);
export const SITE_PROBLEM_EVENT = 'known:site-adapter-problem';
export const sendSiteMessage = async (message: unknown, options?: { reportErrors?: boolean }) => {
  const input = message as Record<string, unknown>;
  const result = await chrome.runtime.sendMessage({ ...input, adapterId: selectedSite.adapterId }).catch(() => ({ error: 'unavailable' })) ?? { error: 'unavailable' };
  if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string'
    && options?.reportErrors !== false && !String(input.kind).includes('.activity.')) document.dispatchEvent(new CustomEvent(SITE_PROBLEM_EVENT,
      { detail: { kind: input.kind, error: (result as { error: string }).error, incidentId: (result as { incidentId?: string }).incidentId } }));
  return result;
};

/** What the sidebar says about a site, from its status reply. */
export interface SiteNavStatus { enabled?: boolean; connected?: boolean; candidateAccount?: string | null; documents?: number; error?: string; archiveHold?: string | null;
  activity?: { problem?: unknown };
  archive?: { config?: { state: string } | null; import?: { phase: string; reason?: string | null } | null } }
function navState(status: SiteNavStatus | undefined): { label: string; tone: 'on' | 'off' | 'warning' } {
  if (!status || status.error) return { label: '', tone: 'off' };
  if (status.candidateAccount) return { label: t('sites_navConnect', 'Connect account'), tone: 'warning' };
  if (!status.enabled) return { label: t('sites_off', 'Off'), tone: 'off' };
  if (status.archive?.config?.state === 'disabled') return { label: t('sites_paused', 'Paused.'), tone: 'off' };
  if (status.archiveHold || status.activity?.problem || status.archive?.config?.state === 'active' && !status.connected
    || status.archive?.import?.phase === 'attention' || status.archive?.import?.phase === 'paused' && status.archive.import.reason !== 'scanFinished')
    return { label: t('sites_connectionNeedsAttention', 'Needs attention'), tone: 'warning' };
  if (status.archive?.config?.state === 'active' && status.enabled) return { label: t('sites_connected', 'Connected'), tone: 'on' };
  if (status.connected) return { label: t('sites_connected', 'Connected'), tone: 'on' };
  return { label: status.enabled ? t('sites_on', 'On') : t('sites_off', 'Off'), tone: 'off' };
}
const navItems = new Map<string, HTMLAnchorElement>();
/** Paint one site's state line in the sidebar. */
export function paintSiteNav(adapterId: string, status: SiteNavStatus | undefined) {
  const item = navItems.get(adapterId); if (!item) return;
  const state = navState(status), line = item.querySelector<HTMLElement>('.sites-nav-state')!, dot = item.querySelector<HTMLElement>('.set-dot')!;
  line.lastElementChild!.textContent = state.label; dot.dataset.tone = state.tone; line.hidden = !state.label;
}
/** The sidebar's Sites list: every site this browser can read. Other sites ask for their own state once. */
export function mountSiteNav() {
  const list = document.querySelector<HTMLElement>('#site-list')!;
  for (const site of bundledSites) {
    const item = document.createElement('a'), mark = createSiteMark({ label: site.label, origin: site.origin, icon: site.icon, size: 20 }),
      text = document.createElement('span'), name = document.createElement('span'), state = document.createElement('span');
    item.className = 'side-item sites-nav-item'; item.href = siteHref(site); item.dataset.adapterId = site.adapterId;
    text.className = 'sites-nav-text'; name.className = 'sites-nav-name'; name.textContent = site.label;
    state.className = 'sites-nav-state'; state.hidden = true; state.append(Object.assign(document.createElement('span'), { className: 'set-dot' }), document.createElement('span'));
    text.append(name, state); item.append(mark, text); list.append(item); navItems.set(site.adapterId, item);
    if (site.adapterId !== selectedSite.adapterId) void chrome.runtime.sendMessage({ kind: 'known.siteAdapters.status', adapterId: site.adapterId })
      .then(r => paintSiteNav(site.adapterId, r as SiteNavStatus), () => undefined);
  }
}
const siteHref = (site: SiteDefinition) => `site-adapters.html?adapterId=${encodeURIComponent(site.adapterId)}#sync`;

export type SiteTab = 'sync' | 'cloud' | 'recovery';
export interface SiteRoute { view: 'site' | 'packages'; tab: SiteTab }
const TABS: readonly SiteTab[] = ['sync', 'cloud', 'recovery'];
export function currentRoute(): SiteRoute {
  const hash = location.hash.slice(1);
  return hash === 'packages' ? { view: 'packages', tab: 'sync' } : { view: 'site', tab: TABS.includes(hash as SiteTab) ? hash as SiteTab : 'sync' };
}
const routeListeners: ((route: SiteRoute) => void)[] = [];
export const onRoute = (listener: (route: SiteRoute) => void) => { routeListeners.push(listener); };
const PANELS: Record<SiteTab, string> = { sync: 'panel-sync', cloud: 'panel-cloud', recovery: 'panel-recovery' };
/** One page, several views: the hash picks the site view (#sync, or the advanced #cloud and #recovery, which lead back
    through the breadcrumb) or the Add-on packages view (#packages). */
export function mountRoutes() {
  const paint = () => {
    const route = currentRoute();
    document.body.dataset.view = route.view; document.body.dataset.tab = route.tab;
    document.querySelector<HTMLElement>('#view-site')!.hidden = route.view !== 'site';
    document.querySelector<HTMLElement>('#view-packages')!.hidden = route.view !== 'packages';
    for (const tab of TABS) document.querySelector<HTMLElement>(`#${PANELS[tab]}`)!.hidden = tab !== route.tab;
    document.querySelector<HTMLElement>('#site-crumbs')!.hidden = route.tab === 'sync';
    document.querySelector<HTMLElement>('#site-crumb-current')!.textContent = route.tab === 'cloud' ? t('sites_tabCloud', 'COLP Server')
      : route.tab === 'recovery' ? t('sites_tabRecovery', 'Recovery') : '';
    for (const [id, item] of navItems) { if (route.view === 'site' && id === selectedSite.adapterId) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
    const packages = document.querySelector<HTMLElement>('#nav-packages')!;
    if (route.view === 'packages') packages.setAttribute('aria-current', 'page'); else packages.removeAttribute('aria-current');
    for (const listener of routeListeners) listener(route);
  };
  addEventListener('hashchange', paint); paint();
}
export function showTab(tab: SiteTab) { if (location.hash !== `#${tab}`) location.hash = tab; }

/** A kit button (docs/ui-design.md): secondary unless the step approves something. */
export function siteButton(label: string, tone: 'primary' | 'secondary' | 'ghost' = 'secondary') {
  const button = document.createElement('button'); button.type = 'button'; button.className = `btn btn-${tone} btn-sm`; button.textContent = label; return button;
}
/** A settings row: title and hint on the left, `control` at the end (stacked under the text when `stack`). */
export function siteRow(title: string, hint: string, stack = false) {
  const row = document.createElement('div'), text = document.createElement('div'), heading = document.createElement('p'), control = document.createElement('div');
  row.className = stack ? 'set-row set-row--stack' : 'set-row'; text.className = 'set-row-text'; heading.className = 'set-row-title'; control.className = 'set-row-control';
  heading.textContent = title; text.append(heading);
  if (hint) { const p = document.createElement('p'); p.className = 'set-row-hint'; p.textContent = hint; text.append(p); }
  row.append(text, control); return { row, text, control };
}
/** Show an action only while it can run: a step that can't run yet is hidden, not greyed. */
export function offer(button: HTMLButtonElement, available: boolean) { button.disabled = !available; button.hidden = !available; }
