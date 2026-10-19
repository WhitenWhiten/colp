import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { BADGE_ACCENT, BADGE_DANGER, BADGE_MUTED, BADGE_WARNING } from '../src/badge-colors.js';
import { tokensSourcePath } from '../scripts/sync-tokens.mjs';

function tokenHex(css: string, name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*rgb\\((\\d+)\\s+(\\d+)\\s+(\\d+)\\)`, 'u'));
  assert.ok(match, `${name} not found as an rgb() triplet in tokens.css`);
  return `#${[match[1], match[2], match[3]]
    .map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`;
}

describe('action badge colors', () => {
  test('badge constants match the shared design tokens', async () => {
    const tokens = await readFile(tokensSourcePath, 'utf8');
    assert.strictEqual(BADGE_ACCENT, tokenHex(tokens, '--accent'));
    assert.strictEqual(BADGE_DANGER, tokenHex(tokens, '--danger'));
    assert.strictEqual(BADGE_MUTED, tokenHex(tokens, '--muted'));
    assert.strictEqual(BADGE_WARNING, tokenHex(tokens, '--warning'));
  });
});
