import { boundedJson, record } from './http.js';
import { favoriteRequest } from './probe-wire.js';
/** Audited MAIN entry: hints only, forgeable by the page, no host credentials. */
(() => {
  const key = '__knownBilibiliProbeV1';
  const scope = globalThis as typeof globalThis & { [key]?: { destroy(): void } };
  if (location.origin !== 'https://www.bilibili.com' || window.top !== window || scope[key]) return;
  const originalFetch = window.fetch, originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
  let active = true, pending = 0;
  const publish = (request: NonNullable<ReturnType<typeof favoriteRequest>>, interactionId: string, value: unknown) => {
    const code = record(value).code;
    if (active && Number.isSafeInteger(code)) window.dispatchEvent(new CustomEvent('known-bilibili-favorite-hint', {
      detail: { ...request, interactionId, code },
    }));
  };
  const wrappedFetch: typeof fetch = function(this: Window, input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = favoriteRequest(url, init?.method ?? (input instanceof Request ? input.method : 'GET'), init?.body);
    const interactionId = crypto.randomUUID();
    const promise = Reflect.apply(originalFetch, this, [input, init]) as ReturnType<typeof fetch>;
    if (request && pending < 16) {
      pending++;
      void promise.then(async response => {
        if (response.ok && active) publish(request, interactionId, await boundedJson(response.clone(), 65536));
      }).catch(() => undefined).finally(() => { pending--; });
    }
    return promise; // no extra await, writes, retries or changed site exception semantics
  };
  const metadata = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  const listeners = new Map<XMLHttpRequest, () => void>();
  const wrappedOpen = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    metadata.set(this, { url: String(url), method });
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;
  const wrappedSend = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = metadata.get(this), request = meta && favoriteRequest(meta.url, meta.method, body);
    if (request && listeners.size < 16) {
      const xhr = this, interactionId = crypto.randomUUID();
      const loaded = () => {
        listeners.delete(xhr);
        try {
          if (!active || xhr.status < 200 || xhr.status >= 300) return;
          if (xhr.responseType === 'json') publish(request, interactionId, xhr.response);
          else if ((!xhr.responseType || xhr.responseType === 'text') && xhr.responseText.length <= 65536)
            publish(request, interactionId, JSON.parse(xhr.responseText));
        } catch { /* business/parse failures never change the site's response */ }
      };
      listeners.set(xhr, loaded); xhr.addEventListener('loadend', loaded, { once: true });
    }
    return Reflect.apply(originalSend, this, [body]);
  };
  window.fetch = wrappedFetch; XMLHttpRequest.prototype.open = wrappedOpen; XMLHttpRequest.prototype.send = wrappedSend;
  const destroy = () => {
    active = false;
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = originalSend;
    for (const [xhr, listener] of listeners) xhr.removeEventListener('loadend', listener);
    listeners.clear(); window.removeEventListener('known-site-probe-stop', destroy); delete scope[key];
  };
  scope[key] = { destroy }; window.addEventListener('known-site-probe-stop', destroy);
})();
