import { BILIBILI } from './bilibili/identity.js';
import { SITE_PORT } from './transport.js';
import type { BootstrapReply, SourceIdentityClaim } from './contracts.js';
const slot = '__knownSiteAdapterV1';
const scope = globalThis as typeof globalThis & { [slot]?: { restart(): void } };
if (location.origin === BILIBILI.origin && window.top === window) {
  if (scope[slot]) scope[slot].restart();
  else {
    let controller: AbortController | null = null, port: chrome.runtime.Port | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let epoch = 0;
    const stop = () => { epoch++; controller?.abort(); controller = null; port?.disconnect(); port = null; clearTimeout(timer); };
    const restart = () => { stop(); const current = epoch; controller = new AbortController();
      void (async () => {
        // Fixed, separately bounded pre-bootstrap detector. Replaced by the shared reader in SA-02.
        const signal = AbortSignal.any([controller!.signal, AbortSignal.timeout(8000)]);
        let source: SourceIdentityClaim = { state: 'unknown' };
        try {
          const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include', redirect: 'error', signal });
          const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
          if (!response.ok || !reader) throw new Error('unavailable');
          try { for (;;) { const { value, done } = await reader.read(); if (done) break;
            bytes += value.byteLength; if (bytes > 65536) throw new Error('capacity'); chunks.push(value); }
          } finally { await reader.cancel().catch(() => undefined); }
          const all = new Uint8Array(bytes); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.length; }
          const json = JSON.parse(new TextDecoder().decode(all));
          if (json.code === -101 || json.data?.isLogin === false) source = { state: 'signedOut' };
          else if (json.code === 0 && json.data?.isLogin === true && Number.isSafeInteger(json.data.mid) && json.data.mid > 0)
            source = { state: 'signedIn', accountId: String(json.data.mid) };
        } catch { /* unknown is never an empty account */ }
        if (epoch !== current) return;
        const reply = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.bootstrap', request: {
          protocolVersion: 1, operation: 'hello', adapterId: BILIBILI.adapterId, runtime: 'bundled', source } }) as BootstrapReply;
        if (epoch !== current) return;
        if (reply.status !== 'ready') { deactivate(); return; }
        port = chrome.runtime.connect({ name: SITE_PORT });
        const ownPort = port;
        port.onDisconnect.addListener(() => { if (port === ownPort) deactivate(); });
        port.onMessage.addListener(raw => { if ((raw as { operation?: string }).operation === 'invalidateLease') restart(); });
        // A bounded handshake, not an observation or write authorization.
        port.postMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), leaseId: reply.leaseId, capability: reply.capability,
          operation: 'connect' });
        timer = setTimeout(restart, Math.max(1000, reply.expiresAt - Date.now() - 1000));
      })().catch(() => stop());
    };
    const deactivate = () => {
      stop();
      window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', restart);
      window.removeEventListener('popstate', restart); window.removeEventListener('hashchange', restart);
      delete scope[slot];
    };
    scope[slot] = { restart };
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', restart);
    window.addEventListener('popstate', restart);
    window.addEventListener('hashchange', restart);
    restart();
  }
}
