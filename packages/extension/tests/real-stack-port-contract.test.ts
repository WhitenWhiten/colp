import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

const REAL_STACK_SPECS = [
  'mv3-auth-shell.spec.ts',
  'mv3-bookmark-import.spec.ts',
  'mv3-bookmark-roots.spec.ts',
  'mv3-durable-sync-engine.spec.ts',
  'mv3-first-run-sync.spec.ts',
  'mv3-outbound-push.spec.ts',
  'mv3-popup-save.spec.ts',
  'mv3-pull-applier.spec.ts',
  'mv3-bookmark-save-placement-real.spec.ts',
  'mv3-trash-restore.spec.ts',
] as const;

describe('real-stack HTTPS transport contract', () => {
  test('uses an ephemeral loopback port while retaining production TLS authority', async () => {
    const source = await readFile(resolve('e2e/real-stack.ts'), 'utf8');
    assert.match(source, /app\.listen\(\{ host: '127\.0\.0\.1', port: 0 \}\)/u);
    assert.match(source, /MAP known\.example:443 127\.0\.0\.1:\$\{httpsPort\}/u);
    assert.match(source, /MAP identity\.known\.example:443 127\.0\.0\.1:\$\{httpsPort\}/u);
    assert.match(source, /port: httpsPort, servername: 'known\.example'/u);
    assert.match(source, /Host: 'known\.example'/u);
    assert.doesNotMatch(source, /port:\s*443/u);
    assert.doesNotMatch(source, /0\.0\.0\.0|forceReleasePort|waitForPortFree|fuser/u);
  });

  test('every real-stack browser journey installs the dynamic resolver rules', async () => {
    for (const name of REAL_STACK_SPECS) {
      const source = await readFile(resolve('e2e', name), 'utf8');
      assert.match(source, /browserHostResolverRules/u, `${name} must use the stack's bound HTTPS port`);
    }
  });

  test('canonical sibling evidence is ordered by the server position authority', async () => {
    const source = await readFile(resolve('e2e/real-stack.ts'), 'utf8');
    assert.match(source, /canonicalSiblingOrder\(parentId/u);
    assert.match(source, /order by position_token collate "C", id collate "C"/u);
    assert.match(source, /order by parent_id collate "C", position_token collate "C", id collate "C"/u);
    assert.match(source, /canonicalSiblingOrders/u);
  });
});
