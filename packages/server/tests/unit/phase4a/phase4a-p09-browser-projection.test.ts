/**
 * P4A-P09 Chromium suite (Playwright, PRODUCTION consumer entries, real
 * PostgreSQL): the app-origin consumer pages (public collection + search)
 * render from REAL production consumer entries over the REAL owner-private
 * Product fixture (real `attachments` rows, real finalize/replacement/retire
 * facts, markers in the REAL stored bodies).
 *
 * DevTools-observable facts are authoritative: the control resource is
 * visible in the DOM (the consumer links executed) and every private marker
 * is absent from the DOM and from every same-origin network response body.
 * The browser never asserts download UI, file names or OS paths.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  p09BuildProductFixture,
  type P09ProductFixture,
} from '../../support/phase4a-p09-test-helpers.js';
import { runP09BrowserProjectionScenario } from '../../support/phase4a-p09-browser-scenario.js';

describeWithPostgres('P4A-P09 Chromium: app-origin consumer pages over the real Product fixture', () => {
  let isolated: I07MigrationRuntime;
  let fixture: P09ProductFixture;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p09_browser', { maxConnections: 14 });
    fixture = await p09BuildProductFixture({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
    });
  }, 180_000);

  afterAll(async () => {
    await fixture?.bundle.app.close();
    await fixture?.bundle.store.close();
    await fixture?.objectServer.close();
    await isolated?.dropSchema();
  });

  test('public collection + search pages serve the control resource and never expose any private marker', async () => {
    const result = await runP09BrowserProjectionScenario({
      runtime: isolated,
      collectionId: fixture.collectionId,
      controlNodeTitle: fixture.controlNodeTitle,
      privateMarkers: Object.values(fixture.markers),
    });

    assert.equal(result.pagesLoaded, 2, 'both app-origin consumer surfaces must load');
    assert.equal(result.controlCollectionVisibleInDom, true,
      'control collection must be visible (link executed)');
    assert.equal(result.controlNodeVisibleInDom, true,
      'control node must be visible (link executed)');
    assert.equal(result.controlSearchResultVisibleInDom, true,
      'the control search result must be visible (link executed)');
    assert.deepEqual(result.privateMarkersInDom, [],
      'no private marker may ever render in the DOM');
    assert.deepEqual(result.privateMarkersInResponses, [],
      'no private marker may ever appear in any same-origin response body');
    assert.ok(result.responseCount >= 2, 'page HTML responses must be observed over DevTools');
    assert.match(result.chromiumVersion, /^\d+(\.\d+){2,3}$/);
  });
});
