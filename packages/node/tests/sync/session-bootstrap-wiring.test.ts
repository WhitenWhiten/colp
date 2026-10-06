/**
 * Wiring-honesty guard: the instance-scoped `create_collection` Session
 * bootstrap lane is a package capability with **no known production consumer**:
 * it needs a backend that mints instance-scoped Sessions carrying
 * `collections:create`, and no host is known to do so yet.
 *
 * This file pins two invariants so the gap cannot silently regress either way:
 *   1. `SYNC_WIRE_COMPLETENESS.md` marks the lane as not wired by any known host.
 *   2. `coordinateSessionBootstrap` stays exported — it implements the
 *      normative SYNC-0007 wire semantics and self-gates Session eligibility,
 *      so it is a legitimate (but unwired) package capability, not a
 *      composition-free unsafe coordinator.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as syncApi from '../../src/sync/index.js';
import * as unsafeApi from '../../src/sync/unsafe.js';

const evidence = '[evidence:sync.session-bootstrap]';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const completenessDoc = readFileSync(
  join(packageRoot, 'docs/SYNC_WIRE_COMPLETENESS.md'),
  'utf8',
);

describe(`Session bootstrap lane wiring honesty ${evidence}`, () => {
  it('marks the instance create_collection lane as having no known production consumer', () => {
    const bootstrapRow = completenessDoc
      .split('\n')
      .find((line) => line.includes('coordinateSessionBootstrap'));
    expect(bootstrapRow).toBeDefined();
    // The doc must not claim a deployable capability — it must name the gap:
    // no known backend issues `collections:create` Sessions.
    expect(bootstrapRow).toMatch(/no known production consumer/i);
    expect(bootstrapRow).toMatch(/collections:create/);
  });

  it('keeps coordinateSessionBootstrap on the production barrel, off unsafe', () => {
    expect(typeof syncApi.coordinateSessionBootstrap).toBe('function');
    expect(
      'coordinateSessionBootstrap' in unsafeApi
        && (unsafeApi as { coordinateSessionBootstrap?: unknown })
          .coordinateSessionBootstrap !== undefined,
    ).toBe(false);
  });
});
