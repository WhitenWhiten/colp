import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The web styles wrap capture.css in @layer components for the web cascade.
 * Extension builds extract the same capture recipe without the @layer wrapper
 * so its rules (e.g. .capture-summary-card) are not overridden by unlayered reset in chrome.css.
 */
export async function syncCaptureRecipe(output) {
  const source = await readFile(resolve(import.meta.dirname, '../design/capture.css'), 'utf8');
  const start = source.indexOf('@layer components {');
  if (start < 0) throw new Error('web_capture_recipe_layer_missing');
  const brace = source.indexOf('{', start);
  const lastBrace = source.lastIndexOf('}');
  if (brace < 0 || lastBrace <= brace) throw new Error('web_capture_recipe_braces_malformed');
  const unlayered = source.slice(0, start) + source.slice(brace + 1, lastBrace).trim() + '\n';
  await writeFile(output, `/* Generated from web capture.css; do not edit. */\n${unlayered}`);
}
