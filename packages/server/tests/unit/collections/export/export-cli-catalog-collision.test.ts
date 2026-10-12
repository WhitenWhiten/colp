import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { afterEach, test, vi } from 'vitest';
import type { ExportCollectionSource } from '../../../../src/modules/collections/application/export-collection.js';

/**
 * Runs the real `colp-server export` control flow (slug allocation, snapshot
 * construction, HTML rendering and file writes). Only the process/database
 * boundaries are doubled: configuration, the owner lookup and the read port.
 */
const state = vi.hoisted(() => ({ sources: [] as ExportCollectionSource[] }));

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
  const owner = { accountId: 'principal-owner', subjectId: 'subject-owner', status: 'active', deletedAt: null };
  const query = {
    innerJoin() { return query; },
    select() { return query; },
    where() { return query; },
    async executeTakeFirst() { return owner; },
  };
  return {
    maintenanceDatabaseRuntimeOptions: () => ({}),
    createDatabaseRuntime: () => ({ db: { selectFrom: () => query }, close: async () => undefined }),
  };
});

vi.mock('../../../../src/infrastructure/collections/index.js', () => ({
  createPostgresCollectionExportReadPort: () => ({
    listOwnedIds: async () => state.sources.map((source) => source.id),
    loadForPrincipal: async ({ collectionId }: { collectionId: string }) =>
      state.sources.find((source) => source.id === collectionId) ?? null,
  }),
}));

vi.mock('../../../../src/infrastructure/automation/index.js', () => ({
  exportAutomations: async () => ({ contractVersion: '0.2.1-design', exportedAt: '2026-10-10T00:00:00.000Z', rules: [] }),
}));

const { exportOwnedCollections, uniqueSlug } = await import('../../../../src/cli/export.js');

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

afterEach(async () => {
  state.sources = [];
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
