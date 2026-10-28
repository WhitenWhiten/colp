import { validateAdapterImplementation, matchesSiteUrl } from './registry-validation.js';
import { installationKey } from './installation.js';
import { SITE_PORT } from './transport.js';
import { abortableSleep, SiteReadError, withReadDeadline } from './read-errors.js';
import { validHostCommand, validAdapterMessage } from './schemas.js';
import { readLimits } from './read-policy.js';
import type { SiteDefinition } from './registry-types.js';
import { createPageContext } from './page-context.js';
import type { AdapterMessage, BootstrapReply, HostCommand, ReadFailure, SourceIdentityClaim, SiteAdapter, SiteAdapterFactory, AdmissionReply, SiteObservation, MembershipHint, CaptureControlRequest } from './contracts.js';
export function startAdapterRuntime(definition: SiteDefinition, createAdapter: SiteAdapterFactory) {
  const LIMITS = readLimits(definition);
  // Retire the pre-registry runtime during an in-place extension upgrade.
  window.dispatchEvent(new Event('known-site-adapter-stop'));
  const slot = `__knownSiteAdapterV1:${definition.adapterId}`;
  const stopEvent = `known-site-adapter-stop:${definition.adapterId}`, routeEvent = `known-site-route:${definition.adapterId}`;
  const scope = globalThis as typeof globalThis & Record<string, { restart(): void; version?: number } | undefined>;
  if (matchesSiteUrl(definition, location.href) && window.top === window) {
    if (scope[slot] && scope[slot].version !== 9) window.dispatchEvent(new Event(stopEvent));
    if (scope[slot]) scope[slot].restart();
    else {
      let controller: AbortController | null = null, port: chrome.runtime.Port | null = null, timer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let epoch = 0, reader: SiteAdapter | null = null, readerEpoch: string | undefined;
      const retainedHints = new Map<string, { hint: MembershipHint; readerEpoch: string; accountId: string; expiresAt: number }>();
      let removeHints = () => {};
      const reset = (preserve: boolean) => { removeHints(); removeHints = () => {}; epoch++; controller?.abort(); controller = null; const oldPort = port; port = null; oldPort?.disconnect(); clearTimeout(timer); if (!preserve) { reader?.clear?.(); reader = null; readerEpoch = undefined; } };
      const stop = () => { retainedHints.clear(); reset(false); };
      const begin = (preserve: boolean) => { reset(preserve); const current = epoch; controller = new AbortController(); const signal = controller.signal;
        reader ??= createAdapter(Object.freeze({ readPolicy: LIMITS }));
        validateAdapterImplementation(definition, reader);
        const localReader = reader;
        void (async () => {
          const activationDeadline = Date.now() + LIMITS.activationMs;
          let activation = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.activation', adapterId: definition.adapterId }) as { status: string; activationId?: string; deadlineAt?: number; retryAfterMs?: number };
          for (let attempt = 0; attempt < 2 && ['paused', 'unavailable'].includes(activation.status) && activation.retryAfterMs && Date.now() + activation.retryAfterMs < activationDeadline; attempt++) {
            await abortableSleep(activation.retryAfterMs, signal);
            activation = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.activation', adapterId: definition.adapterId }) as typeof activation;
          }
          if (epoch !== current) return;
          if (activation.status !== 'ready' || !activation.activationId) {
            if (activation.status === 'paused' && activation.retryAfterMs) { reset(true); timer = setTimeout(() => begin(true), Math.max(LIMITS.spacingMs, activation.retryAfterMs)); return; }
            deactivate(); return;
          }
          let source: SourceIdentityClaim = { state: 'unknown' };
          try { const ctx = { document, signal, deadlineAt: Math.min(activationDeadline, activation.deadlineAt ?? activationDeadline) }; source = await withReadDeadline(() => localReader.detectSource(ctx), ctx); }
          catch (e) { if (e instanceof SiteReadError && e.failure.code === 'signedOut') source = { state: 'signedOut' }; }
          if (epoch !== current) return;
          const reply = await chrome.runtime.sendMessage({ kind: 'known.siteAdapters.bootstrap', request: {
            protocolVersion: 1, operation: 'hello', adapterId: definition.adapterId, runtime: 'bundled', activationId: activation.activationId, source } }) as BootstrapReply;
          if (epoch !== current) return;
          if (reply.status !== 'ready' || source.state !== 'signedIn') {
            if (source.state === 'unknown' && reply.status === 'unavailable' && reply.reason === 'sourceUnresolved') recover(true);
            else deactivate(); return;
          }
          if (!reply.readerEpoch || readerEpoch !== reply.readerEpoch) localReader.clear?.();
          readerEpoch = reply.readerEpoch; failures = 0;
          const accountId = source.accountId;
          for (const [id, value] of retainedHints) if (value.readerEpoch !== reply.readerEpoch || value.accountId !== accountId || value.expiresAt <= Date.now()) retainedHints.delete(id);
          port = chrome.runtime.connect({ name: installationKey(SITE_PORT, definition) }); const ownPort = port;
          const envelope = { protocolVersion: 1 as const, leaseId: reply.leaseId, capability: reply.capability };
          let busy = false;
          ownPort.onDisconnect.addListener(() => { if (port === ownPort) { reset(!busy); timer = setTimeout(() => begin(true), LIMITS.spacingMs); } });
          const pending = new Map<string, { resolve(value: AdmissionReply): void; reject(error: Error): void }>();
          const request = (body: { operation: 'emit'; data: SiteObservation } | { operation: 'membership.hint'; hint: MembershipHint } | { operation: 'capture'; data: CaptureControlRequest }): Promise<AdmissionReply> => {
            if (signal.aborted || pending.size >= LIMITS.queue) return Promise.resolve({ status: 'rejected', reason: 'capacity' });
            const requestId = body.operation === 'membership.hint' ? body.hint.interactionId : crypto.randomUUID();
            if (pending.has(requestId)) return Promise.resolve({ status: 'rejected', reason: 'rateLimited' });
            const frozen = structuredClone(body);
            if (frozen.operation === 'membership.hint' && reply.readerEpoch) {
              const prior = retainedHints.get(requestId);
              if (prior && JSON.stringify(prior.hint) !== JSON.stringify(frozen.hint)) return Promise.resolve({ status: 'rejected', reason: 'conflict' });
              if (!prior && retainedHints.size >= LIMITS.queue) return Promise.resolve({ status: 'rejected', reason: 'capacity' });
              if (!prior) retainedHints.set(requestId, { hint: frozen.hint, readerEpoch: reply.readerEpoch, accountId, expiresAt: reply.expiresAt });
            }
            return new Promise((resolve, reject) => {
              let retryTimer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
              const finish = () => { clearTimeout(retryTimer); pending.delete(requestId); };
              const entry = { resolve(value: AdmissionReply) { finish(); resolve(value); }, reject(error: Error) { finish(); reject(error); } };
              pending.set(requestId, entry);
              const send = () => {
                if (signal.aborted || Date.now() >= reply.expiresAt || ++attempts > 3) { entry.reject(new SiteReadError({ code: 'timeout' })); return; }
                retryTimer = setTimeout(send, Math.min(1500, reply.expiresAt - Date.now()));
                try { ownPort.postMessage({ ...envelope, requestId, ...frozen }); } catch { entry.reject(new SiteReadError({ code: 'cancelled' })); }
              };
              send();
            });
          };
          signal.addEventListener('abort', () => { for (const p of pending.values()) p.reject(new SiteReadError({ code: 'cancelled' })); pending.clear(); }, { once: true });
          ownPort.onMessage.addListener(value => {
            const raw = value as { operation?: string; requestId?: string; reply?: AdmissionReply } | null;
            if (raw?.operation !== 'reply' || typeof raw.requestId !== 'string') return;
            const p = pending.get(raw.requestId); if (!p) return;
            if (raw.reply?.status === 'accepted' || raw.reply?.status === 'duplicate'
              || raw.reply?.status === 'rejected' && !['capacity', 'rateLimited'].includes(raw.reply.reason)) retainedHints.delete(raw.requestId);
            if (['accepted', 'duplicate', 'rejected'].includes(raw.reply?.status ?? '')) p.resolve(raw.reply as AdmissionReply);
            else p.reject(new SiteReadError({ code: 'invalidData' }));
          });
          const context = createPageContext({ document, signal, accountId, routeEpoch: reply.routeEpoch, deadlineAt: reply.expiresAt,
            emit: data => request({ operation: 'emit', data }), hint: hint => request({ operation: 'membership.hint', hint }),
            requestCapture: data => request({ operation: 'capture', data }), routeEvent, controls: definition.capabilities.includes('mountCaptureControl') });
          const cleanup = await withReadDeadline(() => localReader.start(context).then(cleanup => { if (signal.aborted) { void cleanup?.(); return; } return cleanup; }), { signal, deadlineAt: Math.min(reply.expiresAt, Date.now() + LIMITS.commandMs) });
          if (epoch !== current) { await cleanup?.(); return; }
          removeHints = () => { void Promise.resolve().then(() => cleanup?.()).catch(() => undefined); };
          const replays = new Map<string, { command: string; message: AdapterMessage }>();
          ownPort.onMessage.addListener(raw => {
            if (epoch !== current || !validHostCommand(raw)) return;
            if (raw.operation === 'shutdown') { if (raw.leaseId === reply.leaseId) deactivate(); return; }
            if (raw.operation === 'renewLease') { if (raw.leaseId === reply.leaseId) begin(true); return; }
            if (raw.operation === 'invalidateLease') { if (raw.leaseId === reply.leaseId) restart(); return; }
            if (raw.operation === 'cancelRead') { restart(); return; }
            if (raw.leaseId !== reply.leaseId || raw.deadlineAt <= Date.now() || raw.deadlineAt > Date.now() + LIMITS.commandMs) return;
            const id = commandId(raw), replay = replays.get(id);
            if (replay) { if (replay.command !== JSON.stringify(raw)) { recover(); return; } ownPort.postMessage(replay.message); return; }
            if (busy) return;
            busy = true;
            void (async () => {
              const ctx = { ...context, readSessionId: 'readSessionId' in raw ? raw.readSessionId : raw.resolutionId, signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, raw.deadlineAt - Date.now()))]), deadlineAt: raw.deadlineAt };
              let result: unknown;
              try {
                const source = await withReadDeadline(() => localReader.detectSource(ctx), ctx);
                if (source.state !== 'signedIn' || source.accountId !== accountId) throw new SiteReadError({ code: 'signedOut' });
                if (raw.operation === 'resolveItem') { if (!localReader.resolveItem) throw new SiteReadError({ code: 'unsupported' }); result = await withReadDeadline(() => localReader.resolveItem!(ctx, raw.url), ctx); }
                else if (raw.operation === 'readPage') result = raw.query.kind === 'collections'
                  ? { status: 'ok', kind: 'collections', page: await required(() => localReader.readCollectionsPage?.(ctx, raw.query.cursor), ctx) }
                  : { status: 'ok', kind: 'items', collectionId: raw.query.collectionId, page: await required(() => localReader.readItemsPage?.(ctx, raw.query.kind === 'items' ? raw.query.collectionId : '', raw.query.cursor), ctx) };
                else result = await required(() => localReader.readMemberships?.(ctx, raw.query), ctx);
                const after = await withReadDeadline(() => localReader.detectSource(ctx), ctx);
                if (after.state !== 'signedIn' || after.accountId !== accountId) throw new SiteReadError({ code: 'signedOut' });
              } catch (e) {
                // Cancellation belongs to the retired route/lease. It must not
                // clear a reused reader or restart the runtime that replaced it.
                if (epoch !== current) return;
                const error: ReadFailure = e instanceof SiteReadError ? e.failure : { code: ctx.signal.aborted ? 'timeout' : 'invalidData' };
                localReader.clear?.(); // An unverified/aborted command cannot leave a partially advanced cursor.
                result = { status: 'failed', error };
                if (error.code === 'signedOut' || error.code === 'timeout' || error.code === 'cancelled') { restart(); return; }
              }
              if (epoch !== current) return;
              let message = { ...envelope, requestId: id, ...resultEnvelope(raw), result } as AdapterMessage;
              if (!validAdapterMessage(message) || !definition.validateMessage(message)) {
                localReader.clear?.(); message = { ...envelope, requestId: id, ...resultEnvelope(raw), result: { status: 'failed', error: { code: 'invalidData' } } } as AdapterMessage;
              }
              replays.set(id, { command: JSON.stringify(raw), message: structuredClone(message) }); if (replays.size > 2) replays.delete(replays.keys().next().value!);
              ownPort.postMessage(message);
            })().catch(() => { if (epoch === current) recover(); }).finally(() => { busy = false; });
          });
          ownPort.postMessage({ ...envelope, requestId: crypto.randomUUID(), operation: 'connect' });
          for (const retained of retainedHints.values()) void request({ operation: 'membership.hint', hint: retained.hint }).catch(() => undefined);
          timer = setTimeout(() => begin(true), Math.max(1000, reply.expiresAt - Date.now() - 1000));
        })().catch(() => { if (epoch === current) recover(); });
      };
      const recover = (preserve = false) => {
        if (++failures > LIMITS.commandAttempts) { deactivate(); return; }
        reset(preserve); timer = setTimeout(() => begin(preserve), LIMITS.spacingMs * failures);
      };
      const restart = () => { window.dispatchEvent(new Event(routeEvent)); begin(false); };
      const deactivate = () => {
        stop();
        window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', restart);
        window.removeEventListener('popstate', restart); window.removeEventListener('hashchange', restart);
        window.removeEventListener(stopEvent, deactivate);
        delete scope[slot];
      };
      scope[slot] = { restart, version: 9 };
      window.addEventListener(stopEvent, deactivate);
      window.addEventListener('pagehide', stop); window.addEventListener('pageshow', restart);
      window.addEventListener('popstate', restart); window.addEventListener('hashchange', restart);
      restart();
    }
  }
}
async function required<T>(work: () => Promise<T> | undefined, context: { signal: AbortSignal; deadlineAt: number }): Promise<T> {
  return withReadDeadline(() => { const value = work(); if (!value) throw new SiteReadError({ code: 'unsupported' }); return value; }, context);
}
type ReadCommand = Exclude<HostCommand, { operation: 'cancelRead' | 'invalidateLease' | 'shutdown' | 'renewLease' }>;
function commandId(c: ReadCommand) { return c.operation === 'resolveItem' ? c.resolutionId : c.operation === 'readPage' ? c.pageRequestId : c.readRequestId; }
function resultEnvelope(c: ReadCommand) {
  if (c.operation === 'resolveItem') return { operation: 'item.result', resolutionId: c.resolutionId };
  if (c.operation === 'readPage') return { operation: 'page.result', readSessionId: c.readSessionId, pageRequestId: c.pageRequestId };
  return { operation: 'membership.result', readSessionId: c.readSessionId, readRequestId: c.readRequestId };
}
