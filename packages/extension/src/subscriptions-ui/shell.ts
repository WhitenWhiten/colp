import type { HubRoute } from '../options-router.js';
import type { SourceRef } from '../bookmark-subscriptions/contracts.js';
import { send, type Send } from './client.js';
import { createSubscriptionList } from './list.js';
import { createMappingDetail } from './detail.js';
import { createSubscriptionDiagnostics } from './diagnostics.js';
import { createWizard } from './wizard.js';
import { createDirectoryPreferences } from './directories.js';
export function createSubscriptionsShell(host: HTMLElement, navigate: (hash: string) => void, worker: Send = send) {
  let current: { dispose(): void } | undefined, extra: { dispose(): void } | undefined, initialSource: SourceRef | undefined, version = 0;
  const listMemory = new Map<string, { scroll: number; focus: string | null }>(); let previousRoute: HubRoute | undefined;
  const content = host.querySelector<HTMLElement>('[data-subscriptions-content]')!, diagnostics = host.querySelector<HTMLElement>('[data-subscription-diagnostics]')!;
  const guarded: Send = async <T>(command: Parameters<Send>[0], requestId?: string) => { const epoch = version; const result = await worker<T>(command, requestId); if (epoch !== version) throw new Error('subscription_scope_changed'); return result; };
  function activate(route: HubRoute) {
    if (previousRoute?.pane === 'subscriptions' && ['list','history'].includes(previousRoute.view)) listMemory.set(previousRoute.hash, { scroll: host.scrollTop, focus: document.activeElement?.id ?? null });
    previousRoute = route; current?.dispose(); extra?.dispose(); current = extra = undefined; version++;
    // The defaults belong to the list; the wizard and a subscription's page stand alone.
    const defaults = host.querySelector<HTMLElement>('#subscription-defaults'); if (defaults) defaults.hidden = !(route.pane === 'subscriptions' && route.view === 'list');
    if (route.pane === 'subscriptions') {
      if (route.view === 'new') { current = createWizard(content, guarded, navigate, initialSource, route.params.get('draft') ?? undefined); initialSource = undefined; }
      else if (route.view === 'detail' && route.params.get('mapping')) current = createMappingDetail(content, guarded, route.params.get('mapping')!, navigate, route.params.get('return') ?? 'subscriptions/list');
      else current = createSubscriptionList(content, guarded, navigate, route.params, route.view === 'history', source => { initialSource = source; navigate('#subscriptions/new'); }, () => { const saved = listMemory.get(route.hash); if (saved) { host.scrollTop = saved.scroll; if (saved.focus) document.getElementById(saved.focus)?.focus({ preventScroll: true }); } });
    }
    if (route.pane === 'help') {
      const category = route.params.get('category') ?? 'all'; diagnostics.hidden = !['all','subscriptions','permissions'].includes(category);
      for (const tab of Array.from(document.querySelectorAll<HTMLElement>('[data-diagnostics-category]'))) { if (tab.dataset.diagnosticsCategory === category) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current'); }
      const sync = document.getElementById('ingress-diagnostics-settings'); if (sync) sync.hidden = !['all','sync'].includes(category);
      const capture = document.getElementById('capture-diagnostics'); if (capture) capture.hidden = !['all','capture','permissions'].includes(category);
      if (!diagnostics.hidden) current = createSubscriptionDiagnostics(diagnostics, guarded, route.params, navigate);
    }
    if (route.pane === 'subscriptions' && route.view === 'list') {
      const directories = document.querySelector<HTMLElement>('[data-subscription-directory-preferences]'); if (directories) extra = createDirectoryPreferences(directories, guarded);
    }
  }
  return { activate, clear() { version++; current?.dispose(); extra?.dispose(); current = extra = undefined; initialSource = undefined; previousRoute = undefined; listMemory.clear(); content.replaceChildren(); diagnostics.replaceChildren(); } };
}
