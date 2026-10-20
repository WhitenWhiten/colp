import type { FirstRunConfirmRequest, FirstRunOrScopeResponse, FirstRunStatusRequest, FirstRunRequest } from './types.js';

const STORAGE_KEY = 'known.firstRun.confirmation.v1';
export const FIRST_RUN_DELIVERY_TIMEOUT_MS = 10_000;
interface Submission {
  readonly request: FirstRunConfirmRequest;
  readonly authority?: FirstRunOrScopeResponse;
  inFlight: boolean; uncertain: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** A submitted command outlives the preview and the options page. An unknown
 * delivery result is retried with the same id, never a newly reviewed command. */
export function createFirstRunConfirmationSession(host: {
  send(request: FirstRunConfirmRequest): Promise<FirstRunOrScopeResponse>;
  pending(): void;
  result(request: FirstRunConfirmRequest, response: FirstRunOrScopeResponse,
    authority?: FirstRunOrScopeResponse): Promise<void>;
}) {
  let current: Submission | undefined;
  let ownerVersion = 0;

  async function save(request: FirstRunConfirmRequest): Promise<void> {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: request }); } catch { /* Worker admission is also durable. */ }
  }
  async function clear(request: FirstRunConfirmRequest): Promise<void> {
    try {
      const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as FirstRunConfirmRequest | undefined;
      if (saved?.confirmationId === request.confirmationId) await chrome.storage.local.set({ [STORAGE_KEY]: null });
    } catch { /* An authoritative status will discard a leftover record on reopen. */ }
  }
  async function finish(ticket: Submission, response: FirstRunOrScopeResponse,
    authority?: FirstRunOrScopeResponse): Promise<void> {
    if (current !== ticket) return;
    current = undefined;
    clearTimeout(ticket.timer);
    const version = ownerVersion;
    await clear(ticket.request);
    if (version === ownerVersion) {
      if (authority) await host.result(ticket.request, response, authority);
      else await host.result(ticket.request, response);
    }
  }
  async function deliver(ticket: Submission): Promise<void> {
    if (current !== ticket || ticket.inFlight) return;
    ticket.inFlight = true;
    // A message port can neither resolve nor reject, including before delivery.
    // Bound each attempt; its late callback cannot settle the subsequent retry.
    const response = await Promise.race([
      Promise.resolve().then(() => host.send(ticket.request))
        .catch(() => ({ ok: false, error: 'extension_unavailable' } as const)),
      new Promise<FirstRunOrScopeResponse>(resolve => {
        ticket.timer = setTimeout(() => resolve({ ok: false, error: 'extension_unavailable' }), FIRST_RUN_DELIVERY_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(ticket.timer);
    if (current !== ticket) return;
    ticket.inFlight = false;
    if (!response.ok && (response.error === 'extension_unavailable' || response.error === 'confirmation_pending')) {
      ticket.uncertain = true; host.pending(); return;
    }
    await finish(ticket, response, !response.ok ? ticket.authority : undefined);
  }
  async function submit(request: FirstRunConfirmRequest, authority?: FirstRunOrScopeResponse): Promise<void> {
    if (current) return;
    const ticket: Submission = { request, ...(authority ? { authority } : {}), inFlight: false, uncertain: false };
    current = ticket; host.pending();
    await save(request);
    await deliver(ticket);
  }
  function observeStatus(response: FirstRunOrScopeResponse): boolean {
    if (!current) return false;
    if (response.ok && 'firstRun' in response
        && response.confirmation?.confirmationId === current.request.confirmationId) {
      if (response.confirmation.state === 'committed') {
        void finish(current, response); return true;
      }
      if (response.confirmation.state === 'missing'
          && (response.firstRun === 'running' || response.firstRun === 'completed')) {
        void finish(current, { ok: false, error: 'confirmation_superseded' }, response); return true;
      }
    }
    if (current.uncertain && !current.inFlight) void deliver(current);
    // A status read saying "none" can race a command before its atomic
    // admission. It is not evidence that the user's submitted command failed.
    return true;
  }
  async function restore(libraryId: string | undefined, status: FirstRunOrScopeResponse): Promise<boolean> {
    if (current) return observeStatus(status);
    if (!libraryId || !status.ok || !('firstRun' in status)) return false;
    const version = ownerVersion;
    let saved: unknown;
    try { saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; } catch { return false; }
    if (version !== ownerVersion || current || !isSavedRequest(saved) || saved.libraryId !== libraryId) return false;
    // A global completed/running state can describe a different tab's command.
    // Replay this saved id so the worker's durable receipt decides its outcome.
    void submit(saved, status.firstRun === 'running' || status.firstRun === 'completed' ? status : undefined);
    return true;
  }
  return {
    get pending() { return current !== undefined; }, submit, observeStatus, restore,
    statusRequest(): FirstRunStatusRequest { return { kind: 'known.firstRun.status',
      ...(current ? { confirmationId: current.request.confirmationId } : {}) }; },
    reset() { ownerVersion += 1; clearTimeout(current?.timer); current = undefined; },
  };
}

function isSavedRequest(input: unknown): input is FirstRunConfirmRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Partial<FirstRunConfirmRequest>;
  return value.kind === 'known.firstRun.confirm' && typeof value.libraryId === 'string' && value.libraryId.length > 0
    && typeof value.previewId === 'string' && value.previewId.length > 0
    && typeof value.confirmationId === 'string' && value.confirmationId.length > 0;
}

export function createFirstRunInputLock(rootTree: HTMLElement) {
  const saved = new Map<HTMLInputElement | HTMLButtonElement, boolean>();
  return (locked: boolean) => {
    rootTree.toggleAttribute('inert', locked);
    if (!locked) {
      for (const [control, disabled] of saved) if (control.isConnected) control.disabled = disabled;
      saved.clear(); return;
    }
    for (const control of Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '#root-tree input, #root-tree button, #folder-card .card-bar button, #cancel-roots'))) {
      if (!saved.has(control)) saved.set(control, control.disabled);
      control.disabled = true;
    }
  };
}

const COLLECTION_BINDING = 'known.sync.collection.v1';

export async function firstRunMessage(message: FirstRunRequest): Promise<FirstRunOrScopeResponse> {
  try {
    const value: unknown = await chrome.runtime.sendMessage(message);
    return value && typeof value === 'object' && 'ok' in value ? value as FirstRunOrScopeResponse : { ok: false, error: 'extension_unavailable' };
  }
  catch { return { ok: false, error: 'extension_unavailable' }; }
}

export async function boundLibraryId(): Promise<string | undefined> {
  try {
    const value = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch { return undefined; }
}
