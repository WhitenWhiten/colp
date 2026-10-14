import { setHidden } from './popup-dom.js';

/**
 * The popup's one quiet line under the fields. Several parts of the popup
 * have something to say (a save error, a suggestion result, a sync fact, a
 * cost), but the popup shows at most one of them: an error always wins, then
 * the first non-empty source in this order. Each source owns its own text and
 * clears it independently, so none has to know about the others.
 */
export type NoteSource = 'feedback' | 'classify' | 'rule' | 'status' | 'dest' | 'cost' | 'digest';
export type NoteTone = '' | 'error';
/** New automation results come last: anything about the page in front wins. */
const ORDER: readonly NoteSource[] = ['feedback', 'classify', 'rule', 'status', 'dest', 'cost', 'digest'];

export interface PopupNote {
  /** Writes (or, with undefined/empty text, clears) one source and repaints the line. */
  set(source: NoteSource, content: string | Node | undefined, tone?: NoteTone): void;
  /** The source currently on screen, for tests and callers that adapt around it. */
  current(): NoteSource | undefined;
}

export function createPopupNote(host: HTMLElement): PopupNote {
  const entries = new Map<NoteSource, { content: string | Node; tone: NoteTone }>();
  const pick = (): NoteSource | undefined => {
    const filled = ORDER.filter((source) => entries.has(source));
    return filled.find((source) => entries.get(source)!.tone === 'error') ?? filled[0];
  };
  function paint(): void {
    const source = pick();
    const entry = source ? entries.get(source) : undefined;
    if (!entry) {
      host.replaceChildren();
      delete host.dataset.tone;
      setHidden(host, true);
      return;
    }
    host.replaceChildren(typeof entry.content === 'string' ? document.createTextNode(entry.content) : entry.content);
    if (entry.tone) host.dataset.tone = entry.tone; else delete host.dataset.tone;
    setHidden(host, false);
  }
  return {
    set(source, content, tone = '') {
      if (content === undefined || content === '') entries.delete(source);
      else entries.set(source, { content, tone });
      paint();
    },
    current: pick,
  };
}
