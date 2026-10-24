import { t } from '../i18n.js';
import type { AdapterContext, AdmissionReply, CaptureControlRequest, MembershipHint, SiteObservation } from './contracts.js';
import { SiteReadError } from './read-errors.js';
/** Every SDK-owned listener/control is tied to the current lease's cancellation signal. */
export function createPageContext(input: {
  document: Document; signal: AbortSignal; accountId: string; routeEpoch: number; deadlineAt: number;
  emit(value: SiteObservation): Promise<AdmissionReply>;
  hint(value: MembershipHint): Promise<AdmissionReply>;
  requestCapture(value: CaptureControlRequest): Promise<AdmissionReply>;
  routeEvent: string; controls: boolean;
}): AdapterContext {
  const own = (cleanup: () => void) => {
    let disposed = false;
    if (input.signal.aborted) { cleanup(); return cleanup; }
    const dispose = () => { if (disposed) return; disposed = true; input.signal.removeEventListener('abort', dispose); cleanup(); };
    input.signal.addEventListener('abort', dispose, { once: true }); return dispose;
  };
  const controls = new Map<string, () => void>();
  return {
    ...input,
    onRouteChange(callback) { const window = input.document.defaultView; window?.addEventListener(input.routeEvent, callback); return own(() => window?.removeEventListener(input.routeEvent, callback)); },
    dom: {
      on(root, event, selector, callback) {
        const listener = (e: Event) => { const target = e.target as Element | null; const element = target?.closest?.(selector);
          if (element && root.contains(element) && !input.signal.aborted) callback(element, e); };
        root.addEventListener(event, listener); return own(() => root.removeEventListener(event, listener));
      },
      observe(root, options, callback) {
        const observer = new MutationObserver(records => { if (!input.signal.aborted) callback(records); });
        observer.observe(root, options); return own(() => observer.disconnect());
      },
      waitFor(read, options) {
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return Promise.reject(new SiteReadError({ code: 'invalidData' }));
        return new Promise((resolve, reject) => {
          const signal = AbortSignal.any([input.signal, options.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const end = Date.now() + Math.min(30000, Math.max(1, options.timeoutMs));
          const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
          const abort = () => { cleanup(); reject(new SiteReadError({ code: 'cancelled' })); };
          const poll = () => {
            if (signal.aborted) { abort(); return; }
            try { const value = read(); if (value !== null) { cleanup(); resolve(value); return; } }
            catch (error) { cleanup(); reject(error); return; }
            if (Date.now() >= end) { cleanup(); reject(new SiteReadError({ code: 'timeout' })); return; }
            timer = setTimeout(poll, 50);
          };
          signal.addEventListener('abort', abort, { once: true }); poll();
        });
      },
    },
    ui: {
      mountControl(control) {
        if (!input.controls) throw new SiteReadError({ code: 'unsupported' });
        controls.get(control.id)?.();
        const button = input.document.createElement('button'); button.type = 'button';
        button.textContent = control.action === 'save' ? t('common_save', 'Save') : t('site_adapter_saveAndClassify', 'Save and classify');
        button.onclick = () => { void control.resolveItem().then(item => { if (item && !input.signal.aborted) return input.requestCapture({ type: 'capture.requested', item, requestedPurpose: control.purpose }); }).catch(() => undefined); };
        control.anchor.insertAdjacentElement(control.position, button);
        const cleanup = own(() => { button.remove(); button.onclick = null; controls.delete(control.id); }); controls.set(control.id, cleanup); return cleanup;
      },
    },
  };
}
