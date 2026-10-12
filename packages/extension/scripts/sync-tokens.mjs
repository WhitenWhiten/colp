/**
 * Copy Know-N web design tokens into the extension build.
 * Source of truth: design/tokens.css, Know-N web's tokens copied into this package
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const tokensSourcePath = resolve(root, 'design/tokens.css');

export function extractRootBlock(css) {
  const start = css.indexOf(':root');
  if (start < 0) throw new Error('tokens.css is missing a :root block');
  const brace = css.indexOf('{', start);
  if (brace < 0) throw new Error('tokens.css :root block is malformed');
  let depth = 0;
  for (let i = brace; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(brace + 1, i).trimEnd();
    }
  }
  throw new Error('tokens.css :root block is unclosed');
}

export function renderGeneratedTokens(sourceCss) {
  const body = extractRootBlock(sourceCss);
  return `/* GENERATED from design/tokens.css — do not edit */\n:root {${body}\n}\n`;
}

// Build-only output: written into dist/, never into the source tree.
export async function syncTokens({ source = tokensSourcePath, output }) {
  const sourceCss = await readFile(source, 'utf8');
  const generated = renderGeneratedTokens(sourceCss);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated);
  return output;
}
