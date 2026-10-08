import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';

/**
 * R20 non-null assertion inventory for the Pull/Ack/recovery cluster.
 *
 * The whole project compiles under tsconfig.json with noUncheckedIndexedAccess
 * enabled. Every remaining postfix `!` must be on the
 * allowlist below: either a length-invariant assertion that immediately follows
 * an explicit guard, or the single definite-assignment `let notifyAbort!: T`.
 * Anything else — a SQL row index, a Map lookup, a regex capture group, or a
 * cursor-boundary read guarded only by `!` — fails this test on purpose, so a
 * future change that reintroduces a dangerous unguarded `!` is caught here.
 *
 * The regex counts only POSTFIX non-null assertions: `!` preceded by `)`, `]`
 * or a word character and not followed by `=`. It excludes `!=`, `!==`, logical
 * `!` and `!!`, and the negation of member accesses like `!foo.bar`.
 */

const root = resolve(import.meta.dirname, '../../..');

const CLUSTER_FILES = [
  'src/modules/sync/application/sync-pull.ts',
  'src/modules/sync/application/sync-ack.ts',
  'src/modules/sync/domain/sync-recovery-capability.ts',
  'src/modules/sync/application/sync-evidence-maintenance.ts',
  'src/infrastructure/sync/postgres/sync-pull-postgres.ts',
  'src/infrastructure/async/abort-and-settle.ts',
  'src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts',
  'src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts',
  'src/infrastructure/sync/postgres/sync-pull-cursor-evidence.ts',
  'src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts',
  'src/infrastructure/sync/postgres/sync-pull-page-evidence-postgres.ts',
  'src/infrastructure/sync/postgres/sync-ack-postgres.ts',
  'src/infrastructure/sync/postgres/sync-recovery-postgres.ts',
  'src/infrastructure/sync/postgres/sync-evidence-maintenance-postgres.ts',
];

const NON_NULL_ASSERTION = /(?<=[)\]]|\w)!(?=[^=])/gu;

interface Site {
  readonly line: number;
  readonly text: string;
  readonly count: number;
}

function collectSites(source: string): Site[] {
  const sites: Site[] = [];
  for (const [index, raw] of source.split('\n').entries()) {
    const matches = [...raw.matchAll(NON_NULL_ASSERTION)];
    if (matches.length) sites.push({ line: index + 1, text: raw.trim(), count: matches.length });
  }
  return sites;
}

// Expected remaining postfix `!` sites per file: the token count and the exact
// trimmed lines that may carry them. The count is the safety net against a new
// `!` sneaking onto an already-allowlisted line.
const EXPECTED = new Map<string, { readonly count: number; readonly allowedLines: readonly string[] }>([
  ['src/modules/sync/application/sync-pull.ts', {
    count: 1,
    allowedLines: ['const active = imported[0]!;'],
  }],
  ['src/modules/sync/application/sync-ack.ts', { count: 0, allowedLines: [] }],
  ['src/modules/sync/domain/sync-recovery-capability.ts', { count: 0, allowedLines: [] }],
  ['src/modules/sync/application/sync-evidence-maintenance.ts', { count: 0, allowedLines: [] }],
  ['src/infrastructure/sync/postgres/sync-pull-postgres.ts', {
    count: 2,
    allowedLines: [
      // visible.length > 0 ternary guards both last-element reads.
      'const nextTuple = visible.length > 0 ? tupleFrom(visible[visible.length - 1]!) : after;',
      // visible.length > 0 ternary guards the last event cursor read.
      '? events[events.length - 1]!.cursor',
    ],
  }],
  ['src/infrastructure/async/abort-and-settle.ts', {
    count: 1, allowedLines: ['let notifyAbort!: () => void;'],
  }],
  ['src/infrastructure/sync/postgres/sync-pull-authority-postgres.ts', { count: 0, allowedLines: [] }],
  ['src/infrastructure/sync/postgres/sync-pull-cursor-codec-postgres.ts', {
    count: 1,
    allowedLines: [
      // resolveCursorAnchor already failed when matches.length !== 1.
      'stableId: matches[0]!.stable_id });',
    ],
  }],
  ['src/infrastructure/sync/postgres/sync-pull-cursor-evidence.ts', {
    count: 1,
    allowedLines: [
      // buildIssuedCursorEntries already failed when visible.length !== eventCursors.length.
      'cursor: input.eventCursors[index]!,',
    ],
  }],
  ['src/infrastructure/sync/postgres/sync-pull-recovery-postgres.ts', { count: 0, allowedLines: [] }],
  ['src/infrastructure/sync/postgres/sync-pull-page-evidence-postgres.ts', { count: 0, allowedLines: [] }],
  ['src/infrastructure/sync/postgres/sync-ack-postgres.ts', {
    count: 3,
    allowedLines: [
      // cursorCheckpointRebindProof returns non-null only when checkpoint_cursor is non-null.
      "builder('checkpoint_cursor', '=', replica.checkpoint_cursor!),",
      // sync_replicas checkpoint columns are persisted as one group.
      'kind: replica.checkpoint_stream_kind!, id: replica.checkpoint_stable_id! };',
    ],
  }],
  ['src/infrastructure/sync/postgres/sync-recovery-postgres.ts', {
    count: 3,
    allowedLines: [
      // resolveRecoveryCursorAnchor already failed when matches.length !== 1.
      'stableId: matches[0]!.stable_id });',
      // Loop bound index < pages.length guarantees pages[index].
      'for (let index = 0; index < pages.length; index += 1) { const page = pages[index]!;',
      // pages.length < 1 short-circuits before pages.at(-1) is evaluated.
      "if (pages.length < 1 || offset !== nodeCount || !pages.at(-1)!.complete) deny('invalid_cursor_scope');",
    ],
  }],
  ['src/infrastructure/sync/postgres/sync-evidence-maintenance-postgres.ts', { count: 0, allowedLines: [] }],
]);

for (const relative of CLUSTER_FILES) {
  const path = resolve(root, relative);
  test(`R20 ${relative} keeps only the documented non-null assertions`, async () => {
    const source = await readFile(path, 'utf8');
    const sites = collectSites(source);
    const expected = EXPECTED.get(relative);
    assert.ok(expected, `missing inventory allowlist for ${relative}`);
    const total = sites.reduce((sum, site) => sum + site.count, 0);
    assert.equal(total, expected.count,
      `expected ${expected.count} postfix non-null assertions, found ${total} at ${sites.map((site) => `${site.line}`).join(', ')}`);
    for (const site of sites) {
      assert.ok(expected.allowedLines.some((allowed) => site.text.startsWith(allowed) || allowed.startsWith(site.text)),
        `unguarded \`!\` at ${relative}:${site.line}: ${site.text}`);
    }
    for (const allowed of expected.allowedLines) {
      assert.ok(sites.some((site) => site.text === allowed || allowed.startsWith(site.text)),
        `missing expected allowlisted site in ${relative}: ${allowed}`);
    }
  });
}
