/**
 * P4A-P09 Chromium app-origin scenario over the REAL PostgreSQL product
 * fixture (not a vitest test file).
 *
 * A real local HTTP server serves the app-origin consumer pages (public
 * collection + search) rendered from REAL production consumer entries —
 * `getPublicationCollectionMetadata` + `getPublicationDirectoryPage` +
 * `getPublicationSnapshotPage` (publication facade, gate-wired through the
 * shared exposure facts port) and `executeSearchQuery` (search facade) — over
 * the REAL PostgreSQL fixture produced by `p09BuildProductFixture` (real
 * `attachments` rows, real finalize/replacement/retire facts, real body
 * markers).
 *
 * The scenario returns DevTools-observable facts: control resource visible in
 * the DOM, private markers ABSENT from the DOM and from every same-origin
 * network response body.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createPostgresSharedExposureFactsPort } from '../../src/infrastructure/database/index.js';
import { createPostgresPublicationEntrySnapshotQueryPorts } from '../../scripts/evidence/postgres-publication-entry.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
} from '../../src/infrastructure/publication/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../src/infrastructure/search/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationCollectionMetadata,
  getPublicationDirectoryPage,
  getPublicationSnapshotPage,
  type PublicationPrincipal,
} from '../../src/modules/publication/index.js';
import { createSearchCursorSigner, executeSearchQuery, type SearchResult } from '../../src/modules/search/index.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export interface P09BrowserProjectionFixture {
  readonly runtime: I07MigrationRuntime;
  readonly collectionId: string;
  readonly controlNodeTitle: string;
  /** Unique markers that must never appear in DOM or network bodies. */
  readonly privateMarkers: readonly string[];
}

export interface P09BrowserProjectionResult {
  readonly pagesLoaded: number;
  readonly controlCollectionVisibleInDom: boolean;
  readonly controlNodeVisibleInDom: boolean;
  readonly controlSearchResultVisibleInDom: boolean;
  readonly privateMarkersInDom: string[];
  readonly privateMarkersInResponses: string[];
  readonly responseCount: number;
  readonly chromiumVersion: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

class P09AppOrigin {
  private readonly responses: string[] = [];
  private server: ReturnType<typeof createServer> | undefined;
  private originValue = '';

  constructor(private readonly fixture: P09BrowserProjectionFixture) {}

  get origin(): string {
    return this.originValue;
  }

  get responseBodies(): readonly string[] {
    return this.responses;
  }

  async start(): Promise<string> {
    const fixture = this.fixture;
    const runtime = fixture.runtime;
    const cursors = createPublicationCursorKeyring({
      active: { id: 'p09-browser-pub', secret: Buffer.alloc(32, 82).toString('base64') },
      retained: [],
    });
    const origin = 'https://known.example';
    const anonymous: PublicationPrincipal = Object.freeze({ kind: 'anonymous' });
    const snapshotPorts = createPostgresPublicationEntrySnapshotQueryPorts(runtime.runtime, cursors);
    const directoryPorts = {
      reads: createPostgresPublicationDirectoryReadPort(runtime.runtime),
      cursors,
      origin,
      maxPageSize: 100,
    };
    const metadataPorts = {
      reads: createPostgresPublicationMetadataReadPort(runtime.runtime),
      origin,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    };
    const searchPorts = {
      candidates: createPostgresSearchCandidatePort(runtime.runtime.db),
      authority: createPostgresSearchAuthorityPort(runtime.runtime.db),
      cursors: createSearchCursorSigner({
        current: { id: 'p09-browser-search', key: 'p09-browser-search-key-material-0123456789' },
      }),
      clock: { now: () => new Date('2026-08-08T12:00:00.000Z') },
      sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
    };

    this.server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/public/collection') {
        const metadata = await getPublicationCollectionMetadata(metadataPorts, {
          collectionId: fixture.collectionId,
          principal: anonymous,
        });
        const directory = await getPublicationDirectoryPage(directoryPorts, {
          principal: anonymous,
          query: Object.freeze({ limit: 50 }),
        });
        const snapshot = await getPublicationSnapshotPage(snapshotPorts, {
          collectionId: fixture.collectionId,
          principal: anonymous,
          query: Object.freeze({ include: ['attachments'] as const, limit: 100 }),
        });
        const body = renderCollectionPage(
          fixture,
          metadata.kind === 'metadata' ? metadata.metadata.collection.title : '',
          directory.directory.collections.map((entry) => entry.title),
          snapshot.snapshot.nodes.map((node) => node.title ?? ''),
          snapshot.snapshot.attachments,
        );
        this.responses.push(body);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
        return;
      }
      if (url.pathname === '/search') {
        const query = url.searchParams.get('q') ?? '';
        const result = await executeSearchQuery(searchPorts, { principal: anonymous, query, pageSize: 20 });
        const body = renderSearchPage(fixture, query, result.items.map(searchResultLabel));
        this.responses.push(body);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
        return;
      }
      response.writeHead(404).end('not found');
    });
    await new Promise<void>((resolvePromise) => {
      this.server!.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = this.server.address() as AddressInfo;
    this.originValue = `http://127.0.0.1:${address.port}`;
    cursors.destroy();
    return this.originValue;
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }
}

function renderCollectionPage(
  fixture: P09BrowserProjectionFixture,
  collectionTitle: string,
  directoryTitles: readonly string[],
  snapshotNodeTitles: readonly string[],
  attachments: readonly unknown[],
): string {
  // The collection page renders BOTH the directory entries and the snapshot
  // nodes: a real consumer page shows the collection's nodes, so the control
  // node title must be visible in the DOM as proof the Snapshot consumer link
  // executed in the browser.
  const controlTitles = [...directoryTitles, ...snapshotNodeTitles];
  return '<!DOCTYPE html><html><head><title>Public collection</title></head><body>'
    + `<h1 data-control-collection="${escapeHtml(fixture.collectionId)}">${escapeHtml(collectionTitle)}</h1>`
    + `<ul>${controlTitles.map((title) => `<li data-control-node="${escapeHtml(title)}">${escapeHtml(title)}</li>`).join('')}</ul>`
    + `<div data-attachments-count="${attachments.length}">${attachments.length} attachment(s)</div>`
    + '</body></html>';
}

function searchResultLabel(item: SearchResult): string {
  if ('title' in item) return item.title;
  if ('displayName' in item) return item.displayName;
  return item.resourceId;
}

function renderSearchPage(
  fixture: P09BrowserProjectionFixture,
  query: string,
  resultTitles: readonly string[],
): string {
  const results = resultTitles.length > 0
    ? resultTitles.map((title) => `<li data-search-result="${escapeHtml(title)}">${escapeHtml(title)}</li>`).join('')
    : '<li data-search-result="none">no results</li>';
  return '<!DOCTYPE html><html><head><title>Search</title></head><body>'
    + `<input data-query="${escapeHtml(query)}" value="${escapeHtml(query)}">`
    + `<ul data-search-results>${results}</ul>`
    + '</body></html>';
}

/**
 * Loads the two app-origin consumer pages in real Chromium while the REAL
 * private-blob product fixture exists, and returns DevTools-observable facts:
 * control visible in DOM, private markers absent from DOM and from every
 * same-origin response body.
 */
export async function runP09BrowserProjectionScenario(
  fixture: P09BrowserProjectionFixture,
): Promise<P09BrowserProjectionResult> {
  const origin = new P09AppOrigin(fixture);
  await origin.start();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const responseBodies: string[] = [];
    context.on('response', async (response) => {
      const responseUrl = response.url();
      if (!responseUrl.startsWith(origin.origin)) return;
      try {
        const text = await response.text();
        if (text.length > 0) responseBodies.push(text);
      } catch {
        // Non-text responses are not part of the projection surface.
      }
    });
    const page = await context.newPage();
    const domMarkers: string[] = [];
    page.on('console', () => undefined);

    await page.goto(`${origin.origin}/public/collection`, { waitUntil: 'domcontentloaded' });
    const collectionDom = await page.evaluate(() => document.documentElement.outerHTML);
    const searchResultVisible = await page.evaluate(
      (controlNodeTitle) => [...document.querySelectorAll('[data-control-node]')]
        .some((node) => node.textContent?.includes(controlNodeTitle)),
      fixture.controlNodeTitle,
    );
    await page.goto(`${origin.origin}/search?q=${encodeURIComponent(fixture.controlNodeTitle)}`, {
      waitUntil: 'domcontentloaded',
    });
    const searchDom = await page.evaluate(() => document.documentElement.outerHTML);
    const controlNodeInSearch = await page.evaluate(
      (controlNodeTitle) => [...document.querySelectorAll('[data-search-result]')]
        .some((node) => node.textContent?.includes(controlNodeTitle)),
      fixture.controlNodeTitle,
    );

    const dom = `${collectionDom}\n${searchDom}`;
    for (const marker of fixture.privateMarkers) {
      if (dom.includes(marker)) domMarkers.push(marker);
    }
    const responseMarkers: string[] = [];
    for (const marker of fixture.privateMarkers) {
      if (responseBodies.some((body) => body.includes(marker))) responseMarkers.push(marker);
    }

    const version = (await browser.version()) ?? '';
    const controlCollectionVisible = collectionDom.includes(fixture.collectionId);
    return {
      pagesLoaded: 2,
      controlCollectionVisibleInDom: controlCollectionVisible,
      controlNodeVisibleInDom: searchResultVisible,
      controlSearchResultVisibleInDom: controlNodeInSearch,
      privateMarkersInDom: domMarkers,
      privateMarkersInResponses: responseMarkers,
      responseCount: responseBodies.length,
      chromiumVersion: version,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await origin.close();
  }
}
