import { createCaptureControlView } from './control-view.js';
import { createCaptureLearningView } from './learning-view.js';
import type { HubRoute } from '../options-router.js';
import { createCaptureHistoryViews } from './history-view.js';
import { createCaptureDiagnosticsView } from './diagnostics-view.js';
import { createShortcutsView } from './shortcuts-view.js';
export function createCaptureShell(host: HTMLElement) {
  /* Each view is only fed while its page is the current one: the capture history no longer fetches
     for a reader who opened Settings, and the diagnostics snapshot is still read lazily — once, when
     Help is first opened. The saving statistics are a second reading of the history load, so they
     ride along with the History page and with Help. */
  const controls = createCaptureControlView(host);
  const learning = createCaptureLearningView(host.querySelector<HTMLElement>('[data-capture-learning]')!);
  const history = createCaptureHistoryViews(host);
  const diagnostics = createCaptureDiagnosticsView(host.querySelector<HTMLElement>('[data-capture-view="diagnostics"] [data-capture-content]')!);
  const shortcutsHost = host.querySelector<HTMLElement>('[data-capture-shortcuts]'), shortcuts = shortcutsHost ? createShortcutsView(shortcutsHost) : undefined;
  let diagnosticsActive = false;
  return {
    async activate(route: HubRoute) {
      if (route.pane === 'help' && !diagnosticsActive) { diagnosticsActive = true; void diagnostics.activate(); }
      if (route.pane === 'history' || route.pane === 'help') history.activate(route); else history.deactivate();
      if (route.pane === 'saving') void shortcuts?.activate();
      if (route.pane === 'ai') void learning.activate(); else learning.deactivate();
      // The control view paints the History row, the default folder (Saving) and the spending limit (AI).
      if (['history', 'saving', 'ai'].includes(route.pane)) await controls.activate(); else controls.deactivate();
    },
    deactivate() { controls.deactivate(); history.deactivate(); diagnostics.deactivate(); diagnosticsActive = false; learning.deactivate(); },
    clear() { controls.clear(); history.clear(); learning.deactivate(); },
  };
}
