import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The web keeps ownership; extension builds extract the same complete recipe. */
export async function syncFormRecipe(output) {
  const source = await readFile(resolve(import.meta.dirname, '../design/global.css'), 'utf8');
  const start = source.indexOf('.field {');
  const end = source.indexOf('/* File drop card', start);
  if (start < 0 || end < start || !source.slice(start, end).includes('.field input:focus')) throw new Error('web_form_recipe_boundary_changed');
  await writeFile(output, `/* Generated from web global.css; do not edit. */\n${source.slice(start, end)}`);
}
