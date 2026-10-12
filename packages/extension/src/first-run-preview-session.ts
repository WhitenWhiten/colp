import type { FirstRunPreviewOk } from './types.js';

interface PreviewTicket { readonly selectionKey: string }
type PreviewState = { readonly phase: 'empty' }
  | { readonly phase: 'reading'; readonly ticket: PreviewTicket }
  | { readonly phase: 'ready'; readonly ticket: PreviewTicket; readonly preview: FirstRunPreviewOk; readonly commandId?: string }
  | { readonly phase: 'confirming'; readonly ticket: PreviewTicket; readonly preview: FirstRunPreviewOk; readonly commandId: string };

/** One reviewed selection owns its preview and idempotency key, including retries. */
export function createFirstRunPreviewSession(uuid: () => string = () => crypto.randomUUID()) {
  let state: PreviewState = { phase: 'empty' };
  return {
    get phase(): PreviewState['phase'] { return state.phase; },
    get preview(): FirstRunPreviewOk | undefined { return 'preview' in state ? state.preview : undefined; },
    invalidate() { state = { phase: 'empty' }; },
    read(selectionKey: string): PreviewTicket | undefined {
      if (state.phase === 'confirming') return undefined;
      const ticket = { selectionKey }; state = { phase: 'reading', ticket }; return ticket;
    },
    current(ticket: PreviewTicket, selectionKey: string): boolean {
      return state.phase !== 'empty' && state.ticket === ticket && ticket.selectionKey === selectionKey;
    },
    accept(ticket: PreviewTicket, preview: FirstRunPreviewOk, selectionKey: string): boolean {
      if (state.phase !== 'reading' || state.ticket !== ticket || ticket.selectionKey !== selectionKey) return false;
      state = { phase: 'ready', ticket, preview }; return true;
    },
    confirm(selectionKey: string): { readonly preview: FirstRunPreviewOk; readonly commandId: string } | undefined {
      if (state.phase !== 'ready' || state.ticket.selectionKey !== selectionKey) return undefined;
      const commandId = state.commandId ?? uuid();
      state = { ...state, phase: 'confirming', commandId };
      return { preview: state.preview, commandId };
    },
    finish(commandId: string): boolean {
      if (state.phase !== 'confirming' || state.commandId !== commandId) return false;
      state = { ...state, phase: 'ready' }; return true;
    },
  };
}
