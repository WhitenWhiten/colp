import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

describe('range adjustment preview errors (UX-03)', () => {
  test('range-ui mirrors preview confirm errors to persistent host.rootFeedback', async () => {
    const source = await readFile(new URL('../src/range-ui.ts', import.meta.url), 'utf8');
    assert.match(source, /const message = confirmFailureCopy\(response\.error\);/);
    assert.match(source, /host\.rootFeedback\.textContent = message;/);
    assert.match(source, /hidePreview\(\);/);
  });
});
