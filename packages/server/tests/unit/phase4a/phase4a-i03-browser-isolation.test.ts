import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import {
  ReferenceAppOrigin,
  runIsolatedOriginBrowserScenario,
} from '../../../scripts/evidence/phase4a-i03-browser-scenario.js';
import { createDeliveryHost } from '../../../scripts/evidence/phase4a-i03-delivery-host.js';
import {
  FixturePrivateStore,
  activeHtmlBytes,
  polyglotPdfBytes,
} from '../../support/phase4a-i03-test-helpers.js';

const OWNER = 'subject:owner-1';

describe('P4A-I03 browser isolation (Playwright Chromium)', () => {
  test('active HTML/JS and PDF polyglots never execute or connect back and are forced downloads without app cookies', async () => {
    const app = new ReferenceAppOrigin();
    const cookieName = 'known_session';
    const cookieValue = `i03-session-${randomUUID()}`;
    const appOrigin = await app.start(cookieName, cookieValue);

    const markerHtml = `i03-marker-${randomUUID()}`;
    const markerPolyglot = `i03-marker-${randomUUID()}`;
    const blobHtml = '018f6f7a-8f2a-7a3d-a123-123456789201';
    const generationHtml = '018f6f7a-8f2a-7a3d-a123-123456789202';
    const blobPolyglot = '018f6f7a-8f2a-7a3d-a123-123456789203';
    const generationPolyglot = '018f6f7a-8f2a-7a3d-a123-123456789204';

    const store = new FixturePrivateStore();
    store.seed({
      blobId: blobHtml,
      generationId: generationHtml,
      ownerSubject: OWNER,
      bytes: activeHtmlBytes(markerHtml, `${appOrigin}/beacon?marker=${markerHtml}`),
      mediaType: 'text/html',
      category: 'suspicious',
      etag: '"i03-etag-html-browser"',
    });
    store.seed({
      blobId: blobPolyglot,
      generationId: generationPolyglot,
      ownerSubject: OWNER,
      bytes: polyglotPdfBytes(markerPolyglot, `${appOrigin}/beacon?marker=${markerPolyglot}`),
      mediaType: 'application/pdf',
      category: 'suspicious',
      etag: '"i03-etag-polyglot-browser"',
    });

    const host = createDeliveryHost({ store, appOrigin, hostname: '127.0.0.2' });
    const deliveryOrigin = await host.start();
    try {
      host.issuer.registerActiveGeneration(blobHtml, generationHtml);
      host.issuer.registerActiveGeneration(blobPolyglot, generationPolyglot);
      const capabilityHtml = host.issueForOwner({
        blobId: blobHtml, generationId: generationHtml, ownerSubject: OWNER,
      }).capabilityId;
      const capabilityPolyglot = host.issueForOwner({
        blobId: blobPolyglot, generationId: generationPolyglot, ownerSubject: OWNER,
      }).capabilityId;

      const result = await runIsolatedOriginBrowserScenario({
        hosts: { appOrigin, deliveryOrigin, cookieName, cookieValue },
        objects: [
          { deliveryPath: `/d/${capabilityHtml}`, marker: markerHtml, kind: 'active-html' },
          { deliveryPath: `/d/${capabilityPolyglot}`, marker: markerPolyglot, kind: 'polyglot-pdf' },
        ],
        beaconHits: async (marker: string) => app.beaconHits(marker),
        getDeliveryResponseLog: () => host.requestLog,
      });

      assert.equal(result.originsDistinct, true, 'delivery origin must differ from the app origin host');
      assert.equal(result.downloadNavigations, 2, 'both objects must be download navigations');
      assert.deepEqual(result.deliveryStatuses, [200, 200]);
      for (const headers of result.deliveryHeaders) {
        assert.equal(headers['content-disposition'], 'attachment');
        assert.equal(headers['x-content-type-options'], 'nosniff');
        assert.equal(headers['cache-control'], 'private,no-store');
        assert.equal('set-cookie' in headers, false, 'the isolated origin must never set a cookie');
      }
      assert.equal(result.markersExecuted, 0, 'active content markers must never execute or connect back');
      assert.equal(result.appCookiePresentAtAppOrigin, true, 'sanity: the app cookie must exist on the app origin');
      assert.equal(result.appCookieReceivedAtIsolatedOrigin, false, 'the app cookie must never reach the isolated origin');
      assert.deepEqual(result.executionMarkersInDom, [], 'no marker may mutate the application DOM');
      assert.deepEqual(result.pageContainsMarker, [], 'no marker may appear in any rendered page');
      assert.match(result.chromiumVersion, /^\d+(\.\d+){2,3}$/);
    } finally {
      await host.close();
      await app.close();
    }
  });
});

