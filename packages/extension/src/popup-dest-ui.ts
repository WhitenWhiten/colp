import { setHidden } from './popup-dom.js';
import { urlSummary } from './popup-shell.js';

/**
 * The domain line shows a host/path summary until clicked; then a quiet URL
 * input takes its place. Returns the painter that mirrors the current URL
 * into the summary button. (The folder pill's panel, search included, is the
 * shared tree view in save-folder-ui.ts.)
 */
export function bindUrlDisplay(
  display: HTMLButtonElement, input: HTMLInputElement, rawUrl: () => string,
): () => void {
  display.addEventListener('click', () => {
    setHidden(display, true);
    setHidden(input, false);
    input.focus();
    input.select();
  });
  return function paintUrlDisplay(): void {
    const raw = rawUrl();
    display.textContent = urlSummary(raw);
    display.title = raw;
  };
}
