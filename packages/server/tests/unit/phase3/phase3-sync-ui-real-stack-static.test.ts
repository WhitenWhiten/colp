import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('P3-37 Sync UI real-stack harness', () => {
  it('creates Conflict through the public Sync fixture and never seeds Conflict rows', () => {
    const runner = readFileSync(resolve('scripts/real-stack-e2e.mjs'), 'utf8');
    const fixture = readFileSync(resolve('scripts/phase3-sync-ui-fixture.ts'), 'utf8');
    expect(runner).toContain('phase3-sync-ui-fixture.ts');
    expect(runner).toContain("'/sync/create-conflict'");
    expect(runner).toContain("'/sync/assert-resolution'");
    for (const cursor of ['FOLLOW', 'FEED', 'NOTIFICATION']) {
      expect(runner).toContain(`${cursor}_CURSOR_ACTIVE_KEY_ID`);
      expect(runner).toContain(`${cursor}_CURSOR_ACTIVE_SECRET`);
    }
    expect(fixture).toContain("runtime.execute('two_replica_concurrent_edit'");
    expect(fixture).toContain('runtime.pullUiResolution');
    expect(fixture).not.toMatch(/insertInto\(['"]sync_conflicts['"]\)|insert\s+into\s+sync_conflicts/iu);
  });
});
