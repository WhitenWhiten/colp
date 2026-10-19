import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { ExportCollectionSource } from '../../../../src/modules/collections/application/export-collection.js';

/**
 * Runs the real `colp-server export` control flow (slug allocation, snapshot
 * construction, HTML rendering and file writes). Only the process/database
 * boundaries are doubled: configuration, the owner lookup and the read port.
 */
interface OwnerRow {
  readonly accountId: string;
  readonly subjectId: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

const DEFAULT_OWNER: OwnerRow = {
  accountId: 'principal-owner',
  subjectId: 'subject-owner',
  status: 'active',
  deletedAt: null,
};

const state = vi.hoisted(() => ({
  sources: [] as ExportCollectionSource[],
  ownerRows: [] as OwnerRow[],
  authUsers: [] as Array<{ readonly id: string }>,
  listSubjectIds: [] as string[],
  loadSubjectIds: [] as string[],
  automationPrincipalIds: [] as string[],
}));

vi.mock('../../../../src/bootstrap/self-hosted-preset.js', () => ({
  applySelfHostedPreset: () => undefined,
}));

vi.mock('../../../../src/bootstrap/config.js', () => ({
  loadConfig: () => ({
    databaseUrl: 'postgres://unused.invalid/colp',
    database: { connectionTimeoutMs: 1_000, idleTimeoutMs: 1_000 },
    nodeEnv: 'test',
    databaseSsl: undefined,
    publication: { origin: 'https://colp.example.test' },
  }),
}));

vi.mock('../../../../src/infrastructure/database/index.js', () => {
  const query = (table: string) => {
    const builder = {
      innerJoin() { return builder; },
      select() { return builder; },
      where() { return builder; },
      async executeTakeFirst() {
        return table === 'auth_users as user' ? state.ownerRows[0] : state.authUsers[0];
      },
    };
    return builder;
  };
  return {
    maintenanceDatabaseRuntimeOptions: () => ({}),
    createDatabaseRuntime: () => ({
      db: { selectFrom: (table: string) => query(table) },
      close: async () => undefined,
    }),
  };
});

vi.mock('../../../../src/infrastructure/collections/index.js', () => ({
  createPostgresCollectionExportReadPort: () => ({
    listOwnedIds: async (subjectId: string) => {
      state.listSubjectIds.push(subjectId);
      return state.sources.map((source) => source.id);
    },
    loadForPrincipal: async ({ collectionId, subjectId }: { collectionId: string; subjectId: string }) => {
      state.loadSubjectIds.push(subjectId);
      return state.sources.find((source) => source.id === collectionId) ?? null;
    },
  }),
}));

vi.mock('../../../../src/infrastructure/automation/index.js', () => ({
  exportAutomations: async (_db: unknown, principalId: string) => {
    state.automationPrincipalIds.push(principalId);
    return { contractVersion: '0.2.1-design', exportedAt: '2026-10-10T00:00:00.000Z', rules: [] };
  },
}));

const { ExportCliError, exportOwnedCollections, uniqueSlug } = await import('../../../../src/cli/export.js');

/**
 * The allocator is a synchronous loop, which no test timeout can interrupt.
 * Bounding its probes turns a non-terminating allocation into a failure.
 */
class ProbeBoundedSet extends Set<string> {
  probes = 0;

  override has(value: string): boolean {
    this.probes += 1;
    if (this.probes > 1_000) throw new Error('slug allocation did not terminate');
    return super.has(value);
  }
}

const SAFE_SLUG = /^[A-Za-z0-9._~-]{1,200}$/u;

const validators = createValidatorRegistry();
const stamp = new Date('2026-10-10T00:00:00.000Z');
const directories: string[] = [];

beforeEach(() => {
  state.ownerRows = [{ ...DEFAULT_OWNER }];
  state.authUsers = [];
});

afterEach(async () => {
  state.sources = [];
  state.ownerRows = [];
  state.authUsers = [];
  state.listSubjectIds = [];
  state.loadSubjectIds = [];
  state.automationPrincipalIds = [];
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function collection(
  id: string,
  title: string,
  publication: { readonly slug: string; readonly visibility: 'public' | 'unlisted' } | null = null,
): ExportCollectionSource {
  return {
    id,
    access: 'owner',
    title,
    summary: null,
    kind: 'bookmarks',
    visibility: publication?.visibility ?? 'private',
    publicationSlug: publication?.slug ?? null,
    rootNodeId: `${id}-root`,
    contentRevision: 'rev-content',
    policyRevision: 'rev-policy',
    createdAt: stamp,
    updatedAt: stamp,
    nodes: [
      {
        id: `${id}-root`, parentId: null, kind: 'folder', isRoot: true, title,
        url: null, description: null, tags: [], visibility: 'inherit', position: null,
        revision: 'rev-root', createdAt: stamp, updatedAt: stamp,
      },
      {
        id: `${id}-mark`, parentId: `${id}-root`, kind: 'bookmark', isRoot: false, title: `${id} mark`,
        url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
        position: 'a0', revision: 'rev-mark', createdAt: stamp, updatedAt: stamp,
      },
    ],
    annotations: [],
    relations: [],
  };
}

interface CatalogEntry { readonly id: string; readonly slug: string; readonly title: string; readonly version: string }

async function exportInto(directory: string): Promise<readonly CatalogEntry[]> {
  await exportOwnedCollections({ username: 'owner', outDir: directory });
  const catalog = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(catalog).sort(), ['collections', 'exportedAt', 'server'],
    'index.json must remain the directory catalog');
  return catalog.collections as CatalogEntry[];
}

async function assertEveryCatalogEntryHasItsOwnSnapshot(
  directory: string,
  entries: readonly CatalogEntry[],
): Promise<void> {
  assert.deepEqual(entries.map((entry) => entry.id), state.sources.map((source) => source.id));
  // Content first: a lost snapshot is the user-visible failure.
  for (const entry of entries) {
    const snapshot = JSON.parse(await readFile(join(directory, `${entry.slug}.json`), 'utf8')) as {
      readonly collection?: { readonly id?: string };
    };
    assert.equal(snapshot.collection?.id, entry.id, `${entry.slug}.json must hold collection ${entry.id}`);
    assert.equal(validators.validate('snapshot', snapshot).valid, true, `${entry.slug}.json must be a snapshot`);
    const html = await readFile(join(directory, `${entry.slug}.html`), 'utf8');
    assert.match(html, new RegExp(`https://example\\.test/${entry.id}`, 'u'));
  }
  const stems = entries.map((entry) => entry.slug.toLowerCase());
  assert.equal(new Set(stems).size, stems.length, 'slugs must be unique even case-insensitively');
  assert.equal(stems.includes('index'), false, 'no collection may claim the catalog filename');
  const exportedAutomation = JSON.parse(await readFile(join(directory, 'automations.json'), 'utf8'));
  assert.deepEqual(exportedAutomation.rules, []);
  assert.equal(stems.includes('automations'), false, 'no collection may claim the Automation export filename');
  const expectedFiles = ['index.json', 'automations.json', ...entries.flatMap((entry) => [`${entry.slug}.json`, `${entry.slug}.html`])];
  assert.deepEqual((await readdir(directory)).sort(), expectedFiles.sort());
}

test('export keeps index.json as the catalog when a collection title or publication slug is index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-export-catalog-'));
  directories.push(directory);
  state.sources = [
    collection('col-title-index', 'Index'),
    collection('col-automations', 'Automations'),
    collection('col-published-index', 'Published', { slug: 'index', visibility: 'public' }),
    collection('col-work-a', 'Work'),
    collection('col-work-b', 'Work'),
    // A title without ASCII slug characters falls back to the ID-derived stem,
    // which keeps its case; it must not alias index.json on a case-insensitive disk.
    collection('INDEX', '目录'),
  ];
  const entries = await exportInto(directory);
  await assertEveryCatalogEntryHasItsOwnSnapshot(directory, entries);
  const slugById = Object.fromEntries(entries.map((entry) => [entry.id, entry.slug]));
  assert.equal(slugById['col-title-index'], 'index-col-title-index');
  assert.equal(slugById['col-published-index'], 'index-col-published-index');
  assert.equal(slugById['col-work-a'], 'work');
  assert.equal(slugById['col-work-b'], 'work-col-work-b');
  assert.equal(slugById.INDEX, 'INDEX-INDEX');
});

test('slug allocation keeps the id tail for maximum-length duplicates and case variants', () => {
  const long = 'a'.repeat(200);
  const shared = 's'.repeat(32);
  const used = new ProbeBoundedSet(['index']);
  const exact = ['dup-one', 'dup-two', 'dup-three'].map((id) => uniqueSlug(long, id, used));
  const caseVariant = uniqueSlug('A'.repeat(200), 'dup-case', used);
  // IDs whose first 32 slug characters agree share a suffix and need the sequence.
  const sequenced = [`${shared}-x`, `${shared}-y`, `${shared}-z`].map((id) => uniqueSlug(long, id, used));

  assert.deepEqual(exact, [
    long,
    `${'a'.repeat(200 - '-dup-two'.length)}-dup-two`,
    `${'a'.repeat(200 - '-dup-three'.length)}-dup-three`,
  ]);
  assert.equal(caseVariant, `${'A'.repeat(200 - '-dup-case'.length)}-dup-case`);
  assert.deepEqual(sequenced, [
    `${'a'.repeat(200 - 33)}-${shared}`,
    `${'a'.repeat(200 - 35)}-${shared}-2`,
    `${'a'.repeat(200 - 35)}-${shared}-3`,
  ]);
  const all = [...exact, caseVariant, ...sequenced];
  for (const slug of all) assert.match(slug, SAFE_SLUG);
  assert.equal(new Set(all.map((slug) => slug.toLowerCase())).size, all.length);
  assert.equal(used.size, all.length + 1, 'the catalog reservation stays in place');
  assert.ok(used.probes < 50, `allocation took ${used.probes} probes`);
});

test('export writes maximum-length duplicate and case-variant publication slugs to distinct files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-export-catalog-'));
  directories.push(directory);
  const published = (slug: string) => ({ slug, visibility: 'public' as const });
  state.sources = [
    collection('max-a', 'Max A', published('m'.repeat(200))),
    collection('max-b', 'Max B', published('m'.repeat(200))),
    collection('max-c', 'Max C', published('M'.repeat(200))),
    collection('max-index', 'Index'),
  ];
  // Same inputs, same order, same reservation as the CLI: if this bounded
  // replay terminates, the export below cannot spin either.
  const preflight = new ProbeBoundedSet(['index']);
  const expected = state.sources.map((source) =>
    uniqueSlug(source.publicationSlug ?? source.title.toLowerCase(), source.id, preflight));

  await exportInto(directory);
  const entries = await exportInto(directory);

  await assertEveryCatalogEntryHasItsOwnSnapshot(directory, entries);
  assert.deepEqual(entries.map((entry) => entry.slug), expected);
  assert.deepEqual(expected, [
    'm'.repeat(200),
    `${'m'.repeat(200 - '-max-b'.length)}-max-b`,
    `${'M'.repeat(200 - '-max-c'.length)}-max-c`,
    'index-max-index',
  ]);
});

test('re-exporting into the same directory still replaces the previous export in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-export-catalog-'));
  directories.push(directory);
  state.sources = [collection('col-title-index', 'Index'),
    collection('col-automations', 'Automations'), collection('col-work-a', 'Work')];
  await exportInto(directory);
  const entries = await exportInto(directory);
  await assertEveryCatalogEntryHasItsOwnSnapshot(directory, entries);
});

test('a valid account with zero collections still exports an empty catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-export-owner-'));
  directories.push(directory);
  state.sources = [];

  await exportOwnedCollections({ username: 'owner', outDir: directory });

  assert.deepEqual((await readdir(directory)).sort(), ['automations.json', 'index.json']);
  const catalog = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as {
    readonly collections: readonly CatalogEntry[];
    readonly exportedAt: string;
  };
  assert.deepEqual(catalog.collections, []);
  assert.equal(typeof catalog.exportedAt, 'string');
  const automations = JSON.parse(await readFile(join(directory, 'automations.json'), 'utf8')) as {
    readonly rules: readonly unknown[];
  };
  assert.deepEqual(automations.rules, []);
  // Reads are subject-scoped; the Automation export is account-scoped.
  assert.deepEqual(state.listSubjectIds, ['subject-owner']);
  assert.deepEqual(state.loadSubjectIds, []);
  assert.deepEqual(state.automationPrincipalIds, ['principal-owner']);
});

test('export never substitutes the auth user id or an empty subject for the account mapping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'colp-export-owner-'));
  directories.push(directory);
  state.sources = [collection('col-owned', 'Owned')];

  await exportInto(directory);

  assert.deepEqual(state.listSubjectIds, ['subject-owner']);
  assert.deepEqual(state.loadSubjectIds, ['subject-owner']);
  assert.deepEqual(state.automationPrincipalIds, ['principal-owner']);
  assert.equal(state.listSubjectIds.includes(''), false);
  assert.equal(state.automationPrincipalIds.includes('auth-user-fallback'), false);
});

/**
 * Runs the command against an output directory that does not exist yet, so a
 * rejection that happens after `prepareDirectory` is observable as files.
 */
async function expectExportFailure(
  configure: () => void,
  expectedCode: number,
  message: RegExp,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'colp-export-owner-'));
  directories.push(parent);
  const directory = join(parent, 'out');
  configure();
  await assert.rejects(
    () => exportOwnedCollections({ username: 'owner', outDir: directory }),
    (error: unknown) => {
      assert.ok(error instanceof ExportCliError, `expected ExportCliError, got ${String(error)}`);
      assert.equal(error.code, expectedCode);
      assert.match(error.message, message);
      return true;
    },
  );
  await assert.rejects(access(directory), { code: 'ENOENT' });
  assert.deepEqual(state.listSubjectIds, []);
  assert.deepEqual(state.loadSubjectIds, []);
  assert.deepEqual(state.automationPrincipalIds, []);
}

test('an auth user without an account mapping fails and writes no backup files', async () => {
  // `auth_users` row exists but neither the mapping nor the account join
  // produced an owner; the old fallback silently exported an empty subject.
  await expectExportFailure(() => {
    state.ownerRows = [];
    state.authUsers = [{ id: 'auth-user-fallback' }];
  }, 1, /account mapping/u);
});

test('a mapping to a deleted account stays a non-exportable unknown user', async () => {
  await expectExportFailure(() => {
    state.ownerRows = [{
      accountId: 'principal-deleted',
      subjectId: 'subject-deleted',
      status: 'deleted',
      deletedAt: new Date('2026-10-01T00:00:00.000Z'),
    }];
    state.authUsers = [{ id: 'auth-user-deleted' }];
  }, 3, /unknown user/u);
});

test('an unusable mapped account fails instead of exporting an empty subject', async () => {
  for (const [label, row, message] of [
    ['empty subject', { ...DEFAULT_OWNER, subjectId: '' }, /empty subject id/u],
    ['blank subject', { ...DEFAULT_OWNER, subjectId: '   ' }, /empty subject id/u],
    ['empty account id', { ...DEFAULT_OWNER, accountId: '' }, /empty account id/u],
  ] as const) {
    await expectExportFailure(() => {
      state.ownerRows = [row];
    }, 1, message);
    assert.equal(state.listSubjectIds.length, 0, `${label} must not reach the read port`);
  }
});
