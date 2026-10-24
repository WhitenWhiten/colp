import { BILIBILI } from './bilibili/identity.js';
import { SITE_PORT } from './transport.js';
import { BilibiliReader } from './bilibili/reader.js';
import { abortableSleep, createPageHttp, SiteReadError } from './bilibili/http.js';
import { validHostCommand, validMembershipHint } from './schemas.js';
import { LIMITS } from './limits.js';
import type { AdapterMessage, BootstrapReply, HostCommand, ReadFailure, SourceIdentityClaim } from './contracts.js';
const slot = '__knownSiteAdapterV1';
const scope = globalThis as typeof globalThis & { [slot]?: { restart(): void; version?: number } };
if (location.origin === BILIBILI.origin && window.top === window) {
  if (scope[slot] && scope[slot].version !== 3) window.dispatchEvent(new Event('known-site-adapter-stop'));
  if (scope[slot]) scope[slot].restart();
  else {
    let controller: AbortController | null = null, port: chrome.runtime.Port | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let epoch = 0, reader: BilibiliReader | null = null, readerEpoch: string | undefined;
    let removeHints = () => {};
    const reset = (preserve: boolean) => { removeHints(); removeHints = () => {}; epoch++; controller?.abort(); controller = null; const oldPort = port; port = null; oldPort?.disconnect(); clearTimeout(timer); if (!preserve) { reader?.clear(); reader = null; readerEpoch = undefined; } };
    const stop = () => reset(false);
    const begin = (preserve: boolean) => { reset(preserve); const current = epoch; controller = new AbortController(); const signal = controller.signal;
      reader ??= new BilibiliReader(createPageHttp({ fetch, now: Date.now, sleep: abortableSleep }));
      const localReader = reader;
      void (async () => {
        const activationDeadline = Date.now() + LIMITS.activationMs;
        let activation = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.activation' }) as { status: string; activationId?: string; deadlineAt?: number; retryAfterMs?: number };
        for (let attempt = 0; attempt < 2 && ['paused', 'unavailable'].includes(activation.status) && activation.retryAfterMs && Date.now() + activation.retryAfterMs < activationDeadline; attempt++) {
          await abortableSleep(activation.retryAfterMs, signal);
          activation = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.activation' }) as typeof activation;
        }
        if (epoch !== current) return;
        if (activation.status !== 'ready' || !activation.activationId) {
          if (activation.status === 'paused' && activation.retryAfterMs) { reset(true); timer = setTimeout(() => begin(true), Math.max(LIMITS.spacingMs, activation.retryAfterMs)); return; }
          deactivate(); return;
        }
        let source: SourceIdentityClaim = { state: 'unknown' };
        try { source = await localReader.detectSource({ signal, deadlineAt: Math.min(activationDeadline, activation.deadlineAt ?? activationDeadline) }); }
        catch (e) { if (e instanceof SiteReadError && e.failure.code === 'signedOut') source = { state: 'signedOut' }; }
        if (epoch !== current) return;
        const reply = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.bootstrap', request: {
          protocolVersion: 1, operation: 'hello', adapterId: BILIBILI.adapterId, runtime: 'bundled', activationId: activation.activationId, source } }) as BootstrapReply;
        if (epoch !== current) return;
        if (reply.status !== 'ready' || source.state !== 'signedIn') { deactivate(); return; }
        if (!reply.readerEpoch || readerEpoch !== reply.readerEpoch) localReader.clear();
        readerEpoch = reply.readerEpoch; failures = 0;
        const accountId = source.accountId;
        port = chrome.runtime.connect({ name: SITE_PORT }); const ownPort = port;
        const envelope = { protocolVersion: 1 as const, leaseId: reply.leaseId, capability: reply.capability };
        let busy = false, pendingHints = 0;
        const hints = (event: Event) => {
          const hint: unknown = (event as CustomEvent).detail;
          if (epoch !== current || !validMembershipHint(hint) || pendingHints >= LIMITS.queue) return;
          pendingHints++;
          try { ownPort.postMessage({ ...envelope, requestId: hint.interactionId, operation: 'membership.hint', hint }); }
          catch { /* a lost hint is repaired by later authorized reconciliation */ }
        };
        window.addEventListener('known-bilibili-favorite-hint', hints);
        removeHints = () => window.removeEventListener('known-bilibili-favorite-hint', hints);
        ownPort.onMessage.addListener(raw => {
          if (raw && typeof raw === 'object' && (raw as { operation?: string }).operation === 'reply') pendingHints = Math.max(0, pendingHints - 1);
        });
        const replays = new Map<string, AdapterMessage>();
        ownPort.onDisconnect.addListener(() => { if (port === ownPort) { reset(true); timer = setTimeout(() => begin(true), LIMITS.spacingMs); } });
        ownPort.onMessage.addListener(raw => {
          if (epoch !== current || !validHostCommand(raw)) return;
          if (raw.operation === 'shutdown') { if (raw.leaseId === reply.leaseId) deactivate(); return; }
          if (raw.operation === 'renewLease') { if (raw.leaseId === reply.leaseId) begin(true); return; }
          if (raw.operation === 'invalidateLease') { if (raw.leaseId === reply.leaseId) restart(); return; }
          if (raw.operation === 'cancelRead') { restart(); return; }
          if (raw.leaseId !== reply.leaseId || raw.deadlineAt <= Date.now() || raw.deadlineAt > Date.now() + LIMITS.commandMs) return;
          const id = commandId(raw), replay = replays.get(id);
          if (replay) { ownPort.postMessage(replay); return; }
          if (busy) return;
          busy = true;
          void (async () => {
            const ctx = { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, raw.deadlineAt - Date.now()))]), deadlineAt: raw.deadlineAt };
            let result: unknown;
            try {
              await localReader.verifyAccount(accountId, ctx);
              if (raw.operation === 'resolveItem') result = await localReader.resolveItem(raw.url, ctx);
              else if (raw.operation === 'readPage') result = raw.query.kind === 'collections'
                ? { status: 'ok', kind: 'collections', page: await localReader.readCollectionsPage(accountId, raw.query.cursor, ctx) }
                : { status: 'ok', kind: 'items', collectionId: raw.query.collectionId, page: await localReader.readItemsPage(raw.query.collectionId, raw.query.cursor, ctx) };
              else result = await localReader.readMemberships(raw.query, ctx);
              await localReader.verifyAccount(accountId, ctx);
            } catch (e) {
              const error: ReadFailure = e instanceof SiteReadError ? e.failure : { code: ctx.signal.aborted ? 'timeout' : 'invalidData' };
              localReader.clear(); // An unverified/aborted command cannot leave a partially advanced cursor.
              result = { status: 'failed', error };
              if (error.code === 'signedOut') { restart(); return; }
            }
            if (epoch !== current) return;
            const message = { ...envelope, requestId: id, ...resultEnvelope(raw), result } as AdapterMessage;
            replays.set(id, message); if (replays.size > 2) replays.delete(replays.keys().next().value!);
            ownPort.postMessage(message);
          })().catch(() => { if (epoch === current) recover(); }).finally(() => { busy = false; });
        });
        ownPort.postMessage({ ...envelope, requestId: crypto.randomUUID(), operation: 'connect' });
        timer = setTimeout(() => begin(true), Math.max(1000, reply.expiresAt - Date.now() - 1000));
      })().catch(() => { if (epoch === current) recover(); });
    };
    const recover = () => {
      if (++failures > LIMITS.attempts) { deactivate(); return; }
      reset(true); timer = setTimeout(() => begin(true), LIMITS.spacingMs * failures);
    };
    const restart = () => begin(false);
    const deactivate = () => {
      stop();
      window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', restart);
      window.removeEventListener('popstate', restart); window.removeEventListener('hashchange', restart);
      window.removeEventListener('known-site-adapter-stop', deactivate);
      delete scope[slot];
    };
    scope[slot] = { restart, version: 3 };
    window.addEventListener('known-site-adapter-stop', deactivate);
    window.addEventListener('pagehide', stop); window.addEventListener('pageshow', restart);
    window.addEventListener('popstate', restart); window.addEventListener('hashchange', restart);
    restart();
  }
}
type ReadCommand = Exclude<HostCommand, { operation: 'cancelRead' | 'invalidateLease' | 'shutdown' | 'renewLease' }>;
function commandId(c: ReadCommand) { return c.operation === 'resolveItem' ? c.resolutionId : c.operation === 'readPage' ? c.pageRequestId : c.readRequestId; }
function resultEnvelope(c: ReadCommand) {
  if (c.operation === 'resolveItem') return { operation: 'item.result', resolutionId: c.resolutionId };
  if (c.operation === 'readPage') return { operation: 'page.result', readSessionId: c.readSessionId, pageRequestId: c.pageRequestId };
  return { operation: 'membership.result', readSessionId: c.readSessionId, readRequestId: c.readRequestId };
}
