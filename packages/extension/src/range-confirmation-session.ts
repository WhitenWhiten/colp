import type { PublicRangePreview, PublicRangeResume, RootResponse } from './types.js';

const STORAGE_KEY = 'known.range.confirmation.v1';
export const RANGE_CONFIRMATION_TIMEOUT_MS = 10_000;
interface Submission {
  readonly resume: PublicRangeResume; inFlight: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** A reviewed range is one command across retries and options-page restarts. */
export function createRangeConfirmationSession(host: {
  send(request: PublicRangeResume['request']): Promise<RootResponse>;
  pending(response?: RootResponse): void;
  result(resume: PublicRangeResume, response: RootResponse): Promise<void>;
}) {
  let current: Submission | undefined;
  let version = 0;
  async function persist(resume: PublicRangeResume) {
    const preview = { ...resume.preview, additions: resume.preview.additions.map(row => ({ ...row, title: '', path: '' })),
      shifts: resume.preview.shifts.map(row => ({ ...row, title: '' })),
      removals: resume.preview.removals.map(row => ({ ...row, title: '' })) };
    try { await chrome.storage.local.set({ [STORAGE_KEY]: { ...resume, preview } }); } catch { /* Worker also keeps admitted commands. */ }
  }
  async function finish(ticket: Submission, response: RootResponse) {
    if (current !== ticket) return;
    current = undefined; clearTimeout(ticket.timer);
    const owner = version;
    try {
      const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as PublicRangeResume | undefined;
      if (saved?.request?.confirmationId === ticket.resume.request.confirmationId) await chrome.storage.local.set({ [STORAGE_KEY]: null });
    } catch { /* The immutable worker receipt handles a later replay. */ }
    if (owner === version) await host.result(ticket.resume, response);
  }
  async function retry() {
    const ticket = current;
    if (!ticket || ticket.inFlight) return;
    ticket.inFlight = true; host.pending();
    const response = await Promise.race([
      Promise.resolve().then(() => host.send(ticket.resume.request))
        .catch(() => ({ ok: false, error: 'confirmation_pending' } as const)),
      new Promise<RootResponse>(resolve => {
        ticket.timer = setTimeout(() => resolve({ ok: false, error: 'confirmation_pending' }), RANGE_CONFIRMATION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(ticket.timer);
    if (current !== ticket) return;
    ticket.inFlight = false;
    if (!response.ok && response.error === 'confirmation_pending') { host.pending(response); return; }
    await finish(ticket, response);
  }
  async function submit(resume: PublicRangeResume) {
    if (current) return;
    const ticket: Submission = { resume, inFlight: false };
    current = ticket; host.pending(); await persist(resume);
    if (current === ticket) await retry();
  }
  async function restore(libraryId: string | undefined) {
    if (!libraryId || current) return;
    const owner = version; let saved: unknown;
    try { saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; } catch { return; }
    if (owner !== version || current || !validRangeResume(saved) || saved.libraryId !== libraryId) return;
    void submit(saved);
  }
  return { submit, retry, restore,
    get pending() { return current !== undefined; }, get inFlight() { return current?.inFlight === true; },
    get resume() { return current?.resume; },
    reset() { version += 1; clearTimeout(current?.timer); current = undefined; },
  };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const rows = (value: unknown, validate: (row: unknown) => boolean) => Array.isArray(value)
  && value.length <= 20_000 && value.every(validate);

export function validRangePreview(value: unknown): value is PublicRangePreview {
  if (!record(value) || !text(value.previewId) || !text(value.boundaryVersion) || !text(value.treeDigest)) return false;
  const change = (row: unknown) => record(row) && text(row.ref) && typeof row.title === 'string'
    && count(row.bookmarkCount) && count(row.folderCount) && count(row.affectedCount);
  return ['bookmarkCount', 'folderCount', 'skippedCount', 'addedCount', 'addedBookmarkCount',
    'removedCount', 'shiftCount', 'expiresAt'].every(key => count(value[key]))
    && rows(value.warnings, row => record(row) && text(row.code))
    && rows(value.shifts, change) && rows(value.removals, change)
    && rows(value.additions, row => record(row) && text(row.ref) && typeof row.title === 'string'
      && typeof row.path === 'string' && count(row.bookmarkCount));
}

export function validRangeResume(value: unknown): value is PublicRangeResume {
  if (!record(value) || !text(value.libraryId) || !record(value.request) || !validRangePreview(value.preview)) return false;
  const request = value.request;
  return request.kind === 'known.roots.confirm' && text(request.confirmationId)
    && request.previewId === value.preview.previewId && request.treeDigest === value.preview.treeDigest
    && (request.remoteDeleteRefs === undefined || rows(request.remoteDeleteRefs, text))
    && (request.shiftActions === undefined || rows(request.shiftActions, row => record(row) && text(row.ref)
      && (row.action === 'keep' || row.action === 'unmount')));
}
