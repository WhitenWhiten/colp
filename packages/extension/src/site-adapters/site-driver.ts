import { reconcileBundledScripts } from './browser-registration.js';
import { matchesSiteUrl } from './registry-validation.js';
import { communityWorld } from './community-runtime.js';
import { communityApiAvailable } from './community-authority.js';
import { communityStore, type CommunityInstallation } from './community-state.js';
import type { SiteDefinition } from './registry.js';
type Channel = 'runtime' | 'userScript';
export type NavigationDetails = chrome.webNavigation.CommitDetails;
/** Where a host hears the browser. Bundled hosts listen directly; installed packages' hosts come and go, so a hub feeds them. */
interface HostEvents {
  message(listener: (raw: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void, channel: Channel) => boolean): void;
  connect(listener: (port: chrome.runtime.Port) => void): void;
  navigation(listener: (details: NavigationDetails) => void): void;
  storage(listener: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void): void;
  permissionsAdded(listener: () => void): void;
  permissionsRemoved(listener: (removed: { permissions?: string[]; origins?: string[] }) => void): void;
  tabRemoved(listener: (tabId: number) => void): void;
  alarm(listener: (alarm: chrome.alarms.Alarm) => void): void;
  startup(listener: () => void): void;
  installed(listener: () => void): void;
}
/** How a site's page code is registered, attached and retired. Everything after bootstrap is the same host. */
export interface SiteDriver {
  events: HostEvents;
  /** The channel this site's page code uses for activation, bootstrap and its port. */
  page: Channel;
  /** Browser state outside permissions that the runtime needs, such as Allow User Scripts. */
  available(): Promise<boolean>;
  /** Whether a user-script page holds this installation's current credential. */
  credential(value: unknown): Promise<boolean>;
  register(enabled: boolean): Promise<void>;
  /** `documentId`, when known, is the document whose URL the host checked. */
  inject(tabId: number, withProbe: boolean, documentId?: string): Promise<void>;
  stop(tabId: number): Promise<void>;
  unregister(): Promise<void>;
}
const chromeEvents: HostEvents = {
  message: listener => chrome.runtime.onMessage.addListener((raw, sender, respond) => listener(raw, sender, respond, 'runtime')),
  connect: listener => chrome.runtime.onConnect.addListener(listener),
  navigation: listener => {
    // webNavigation is optional: listen once it is granted.
    let installed = false;
    const install = () => {
      if (installed || !chrome.webNavigation?.onCommitted) return;
      chrome.webNavigation.onCommitted.addListener(listener); chrome.webNavigation.onHistoryStateUpdated.addListener(listener); chrome.webNavigation.onReferenceFragmentUpdated.addListener(listener);
      installed = true;
    };
    install(); chrome.permissions.onAdded.addListener(install);
  },
  storage: listener => chrome.storage.onChanged.addListener(listener),
  permissionsAdded: listener => chrome.permissions.onAdded.addListener(listener),
  permissionsRemoved: listener => chrome.permissions.onRemoved.addListener(listener),
  tabRemoved: listener => chrome.tabs.onRemoved.addListener(listener),
  alarm: listener => chrome.alarms.onAlarm.addListener(listener),
  startup: listener => chrome.runtime.onStartup.addListener(listener),
  installed: listener => chrome.runtime.onInstalled.addListener(listener),
};
export function bundledDriver(definition: SiteDefinition): SiteDriver {
  return { events: chromeEvents, page: 'runtime', available: async () => true, credential: async () => false,
    register: enabled => reconcileBundledScripts(definition, enabled),
    async inject(tabId, withProbe) {
      if (withProbe && definition.scripts.probe) await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [definition.scripts.probe] }).catch(() => undefined);
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [definition.scripts.adapter] }).catch(() => undefined);
    },
    async stop(tabId) {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.dispatchEvent(new Event('known-site-probe-stop')); } }).catch(() => undefined);
      await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
        func: (id: string) => { window.dispatchEvent(new Event(`known-site-adapter-stop:${id}`)); }, args: [definition.adapterId] }).catch(() => undefined);
    },
    unregister: () => reconcileBundledScripts(definition, false) };
}
export function communityDriver(row: CommunityInstallation, definition: SiteDefinition, events: HostEvents): SiteDriver {
  return { events, page: 'userScript',
    available: () => communityApiAvailable().then(() => true, () => false),
    credential: async value => { const current = (await communityStore.read()).find(r => r.id === row.id); return !!current && current.generation === row.generation && current.credential === value; },
    register: async enabled => { if (enabled) await communityWorld.register(row); else await communityWorld.unregister(row); },
    async inject(tabId, _probe, documentId) {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
      if (!frame || frame.documentLifecycle !== 'active' || documentId && frame.documentId !== documentId || !matchesSiteUrl(definition, frame.url)) return;
      await communityWorld.inject(row, tabId, frame.documentId).catch(() => undefined);
    },
    stop: async tabId => { await communityWorld.stop(row, tabId).catch(() => undefined); },
    unregister: () => communityWorld.unregister(row) };
}
/** Settings and the popup; page code never reaches management. */
export function managementPage(sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try { const u = new URL(sender.url); return u.protocol === 'chrome-extension:' && u.hostname === chrome.runtime.id
    && ['/site-adapters.html', '/options.html'].includes(u.pathname); } catch { return false; }
}
/** Installed packages' hosts exist only after the worker reads them; these listeners are there from the first turn and wait for that. */
export function createCommunityEvents(ready: () => Promise<void>) {
  type Listener = (...args: never[]) => unknown;
  const names = ['message', 'connect', 'navigation', 'storage', 'permissionsAdded', 'permissionsRemoved', 'tabRemoved', 'alarm', 'startup', 'installed'] as const;
  const sets = Object.fromEntries(names.map(name => [name, new Set<Listener>()])) as Record<keyof HostEvents, Set<Listener>>;
  const call = (listener: Listener, ...args: unknown[]) => (listener as (...values: unknown[]) => unknown)(...args);
  const emit = (name: keyof HostEvents, ...args: unknown[]) => { void ready().then(() => { for (const listener of [...sets[name]]) call(listener, ...args); }); };
  /** A message for one package's site: the host that takes it answers. */
  const deliver = (raw: unknown, sender: chrome.runtime.MessageSender, channel: Channel) => ready().then(() => new Promise<unknown>(resolve => {
    for (const listener of [...sets.message]) if (call(listener, raw, sender, resolve, channel) === true) return;
    resolve(undefined);
  }));
  function scope() {
    const owned: [Set<Listener>, Listener][] = [];
    const events = Object.fromEntries(names.map(name => [name, (listener: Listener) => { sets[name].add(listener); owned.push([sets[name], listener]); }])) as unknown as HostEvents;
    return { events, dispose: () => { for (const [set, listener] of owned) set.delete(listener); } };
  }
  function install() {
    chrome.runtime.onMessage.addListener((raw, sender, respond) => {
      const addressed = raw as { adapterId?: unknown; request?: { adapterId?: unknown } } | null, target = addressed?.request?.adapterId ?? addressed?.adapterId;
      if (typeof target !== 'string' || !target.startsWith('community.')) return false;
      void deliver(raw, sender, 'runtime').then(value => respond(value ?? { error: 'adapterUnavailable' }), () => respond({ error: 'adapterUnavailable' })); return true;
    });
    let pending = 0, userScripts = false;
    // Like webNavigation, user-script events may appear only once `userScripts` is granted.
    const installUserScripts = () => {
      if (userScripts || !chrome.runtime.onUserScriptMessage || !chrome.runtime.onUserScriptConnect) return;
      userScripts = true;
      chrome.runtime.onUserScriptMessage.addListener((raw, sender, respond) => {
        if (pending >= 16) { respond({ status: 'unavailable', retryAfterMs: 1000 }); return false; }
        pending++;
        void deliver(raw, sender, 'userScript').then(value => respond(value ?? { status: 'unavailable', reason: 'disabled' }), () => respond({ status: 'unavailable', reason: 'disabled' }))
          .finally(() => { pending--; });
        return true;
      });
      chrome.runtime.onUserScriptConnect.addListener(port => {
        // A page can be talking before its host is attached; hold its messages until then.
        const listeners = new Set<(message: unknown, port: chrome.runtime.Port) => void>(), queued: unknown[] = [];
        let attached = false;
        const proxy = { name: port.name, sender: port.sender, postMessage: (message: unknown) => port.postMessage(message), disconnect: () => port.disconnect(),
          onMessage: { addListener: (listener: (message: unknown, port: chrome.runtime.Port) => void) => { listeners.add(listener); } },
          onDisconnect: { addListener: (listener: (port: chrome.runtime.Port) => void) => { port.onDisconnect.addListener(() => listener(proxy)); } } } as unknown as chrome.runtime.Port;
        port.onMessage.addListener(message => { if (!attached) queued.push(message); else for (const listener of [...listeners]) listener(message, proxy); });
        void ready().then(() => {
          for (const listener of [...sets.connect]) call(listener, proxy);
          attached = true;
          if (!listeners.size) { port.disconnect(); return; }
          for (const message of queued.splice(0)) for (const listener of [...listeners]) listener(message, proxy);
        });
      });
    };
    installUserScripts();
    let navigation = false;
    const navigated = (details: NavigationDetails) => emit('navigation', details);
    const installNavigation = () => {
      if (navigation || !chrome.webNavigation?.onCommitted) return;
      chrome.webNavigation.onCommitted.addListener(navigated); chrome.webNavigation.onHistoryStateUpdated.addListener(navigated); chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigated);
      navigation = true;
    };
    installNavigation();
    chrome.storage.onChanged.addListener((changes, area) => emit('storage', changes, area));
    chrome.permissions.onAdded.addListener(() => { installNavigation(); installUserScripts(); emit('permissionsAdded'); });
    chrome.permissions.onRemoved.addListener(removed => emit('permissionsRemoved', removed));
    chrome.tabs.onRemoved.addListener(tabId => emit('tabRemoved', tabId));
    chrome.alarms.onAlarm.addListener(alarm => emit('alarm', alarm));
    chrome.runtime.onStartup.addListener(() => emit('startup'));
    chrome.runtime.onInstalled.addListener(() => emit('installed'));
  }
  return { scope, install };
}
