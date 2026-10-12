/**
 * Derive the extension icon set from the main site's brand tile
 * (design/apple-touch-icon.png — the ink N on paper).
 * The paper tile stays visible on both light and dark browser toolbars;
 * corners are rounded at 20% so the toolbar icon reads as the product mark.
 *
 * Regeneration requires ImageMagick (`convert`). The rendered PNGs are
 * committed, so builds never depend on this script.
 */
import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'design/apple-touch-icon.png');
const output = resolve(root, 'icons');

await access(source);
await mkdir(output, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const radius = Math.round(size * 0.2);
  const target = resolve(output, `icon-${size}.png`);
  await run('convert', [
    source,
    '-resize', `${size}x${size}`,
    '(', '-size', `${size}x${size}`, 'xc:none',
    '-draw', `roundrectangle 0,0,${size - 1},${size - 1},${radius},${radius}`, ')',
    '-alpha', 'set', '-compose', 'DstIn', '-composite',
    target,
  ]);
  process.stdout.write(`rendered ${target}\n`);
}
