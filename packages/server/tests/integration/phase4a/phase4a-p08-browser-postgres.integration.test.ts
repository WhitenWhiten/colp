/**
 * P4A-P08 Chromium suite (Playwright, PRODUCTION composition, real
 * PostgreSQL): active content downloaded through the PRODUCTION download
 * admission + isolated delivery host never executes, the application cookie/
 * storage/service-worker scope never reaches the isolated origin, and
 * same-filename downloads of DIFFERENT blobs stay byte-isolated (no shared
 * cache).
 *
 * The blobs are REAL bytes stored through the production product flow
 * (issue -> independent HTTP PUT -> complete -> production verification) with
 * active HTML/JS, SVG, and PDF-polyglot markers that would beacon out and
 * mutate the DOM if they ever executed. DevTools-observable network facts,
 * cookie jar, storage, and service-worker scope are authoritative; download-
 * bar text and OS save paths are never asserted (plan §4.2.4).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  p08Admit,
  P08_COLLECTION_A,
  p08Bundle,
  p08Config,
  P08ObjectServer,
  p08TokenFrom,
  type P08AdmissionDto,
  type P08Bundle,
} from '../../support/phase4a-p08-test-helpers.js';
import {
  activeHtmlBytes,
  polyglotPdfBytes,
  svgBytes,
} from '../../support/phase4a-i11-test-helpers.js';
import {
  P08_ACTIVE_CONTENT_MEDIA_TYPE,
} from '../../../scripts/phase4a-p08-evidence.js';
import {
  BrowserAppOrigin,
  runI11BrowserScenario,
} from '../../../scripts/evidence/phase4a-i11-browser-scenario.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { p07SeedCollection, p07UploadToStored } from '../../support/phase4a-p07-test-helpers.js';

const COOKIE_NAME = 'known_session';

describeWithPostgres('P4A-P08 Chromium: zero execution and zero cookie at the isolated origin', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let objectServer: P08ObjectServer;
  let appOrigin: BrowserAppOrigin;
  const config = p08Config();
  const cookieValue = `p08-session-${randomUUID()}`;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p08_browser', { maxConnections: 16 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p08-browser-owner', handle: 'p08_browser_owner' });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P08_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    objectServer = new P08ObjectServer();
    const url = await objectServer.start();
    config.r2.endpoint = url;
    appOrigin = new BrowserAppOrigin();
    await appOrigin.start(COOKIE_NAME, cookieValue);
  }, 120_000);

  afterAll(async () => {
    await appOrigin?.close();
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  test('active HTML/SVG/polyglot served through the production admission never execute; the app cookie never reaches the isolated origin; same-filename blobs stay byte-isolated', async () => {
    const bundle: P08Bundle = await p08Bundle({
      runtime: isolated,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      config,
    });
    try {
      const beacon = (marker: string): string => `${appOrigin.origin}/beacon?marker=${marker}`;
      const markerHtml = `p08-html-${randomUUID()}`;
      const markerSvg = `p08-svg-${randomUUID()}`;
      const markerPolyglot = `p08-polyglot-${randomUUID()}`;

      // REAL active-content bytes stored through the production product flow
      // (declared text/plain, the same shared declaration as the real-R2
      // evidence CLI — the bytes sniff suspicious, so any SAFE allowlisted
      // declaration would be quarantined as media_mismatch; text/plain is the
      // unique allowed declaration outside the SAFE allowlist, and the
      // delivery serves octet-stream either way).
      const html = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body: activeHtmlBytes(markerHtml, beacon(markerHtml)),
        mediaType: P08_ACTIVE_CONTENT_MEDIA_TYPE,
      });
      const svg = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body: svgBytes(markerSvg, beacon(markerSvg)),
        mediaType: P08_ACTIVE_CONTENT_MEDIA_TYPE,
      });
      const polyglot = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body: polyglotPdfBytes(markerPolyglot, beacon(markerPolyglot)),
        mediaType: P08_ACTIVE_CONTENT_MEDIA_TYPE,
      });
      const objects = [
        { uploaded: html, marker: markerHtml },
        { uploaded: svg, marker: markerSvg },
        { uploaded: polyglot, marker: markerPolyglot },
      ] as const;
      const sizes = objects.map((object) => object.uploaded.body.byteLength);
      assert.equal(new Set(sizes).size, 3, 'same-filename downloads must differ in bytes (no shared cache)');

      // Capabilities come from the PRODUCTION download admission route only.
      const paths: string[] = [];
      for (const object of objects) {
        const admitted = await p08Admit(bundle.bundle.app, owner, object.uploaded.blobId);
        assert.equal(admitted.statusCode, 200, admitted.body);
        paths.push(`/d/${p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto)}`);
      }

      const result = await runI11BrowserScenario({
        hosts: { appOrigin: appOrigin.origin, deliveryOrigin: bundle.boundOrigin, cookieName: COOKIE_NAME, cookieValue },
        objects: objects.map((object, index) => ({
          deliveryPath: paths[index]!,
          marker: object.marker,
          kind: index === 0 ? 'active-html' : index === 1 ? 'svg' : 'polyglot-pdf',
          expectedByteCount: sizes[index]!,
        })),
        beaconHits: async (marker: string) => appOrigin.beaconHits(marker),
        getDeliveryResponseLog: () => bundle.delivery.deliveryHost.requestLog,
      });

      assert.equal(result.originsDistinct, true, 'the delivery origin must never be same-site with the app origin');
      assert.equal(result.downloadNavigations, 3, 'every object must be a download navigation');
      const responses = result.deliveryResponses.slice(0, 3);
      assert.equal(responses.length, 3, 'DevTools must observe one delivery response per URL');
      for (const response of responses) {
        assert.equal(response.status, 200);
        assert.ok(response.headers['content-disposition']?.startsWith('attachment;'), 'forced download');
        assert.equal(response.headers['content-type'], 'application/octet-stream');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['cache-control'], 'private,no-store');
        assert.equal('set-cookie' in response.headers, false, 'the isolated origin must never set a cookie');
        assert.equal(response.headers.location, undefined, 'never redirect to an R2 URL');
      }
      assert.deepEqual(result.deliveryByteCounts, sizes, 'each blob delivers exactly its own bytes');
      assert.equal(result.markersExecuted, 0, 'active content must never execute or connect back');
      assert.deepEqual(result.executionMarkersInDom, [], 'no marker may mutate any page');
      assert.deepEqual(result.pageContainsMarker, [], 'no marker may appear in any rendered page');
      assert.equal(result.appCookiePresentAtAppOrigin, true, 'sanity: the app cookie exists on the app origin');
      assert.equal(result.appCookieReceivedAtIsolatedOrigin, false, 'the app cookie must never reach the isolated origin');
      assert.equal(result.appStoragePresentAtAppOrigin, true, 'sanity: app storage is populated');
      assert.equal(result.isolatedStorageEmpty, true, 'the isolated origin must have no storage');
      assert.equal(result.isolatedServiceWorkerCount, 0, 'the isolated origin must have no service worker scope');
      assert.match(result.chromiumVersion, /^\d+(\.\d+){2,3}$/);
    } finally {
      await bundle.bundle.app.close();
      await bundle.bundle.store.close();
      await bundle.delivery.close();
    }
  });
});
