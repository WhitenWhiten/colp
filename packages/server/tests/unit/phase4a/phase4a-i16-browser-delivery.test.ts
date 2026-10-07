/**
 * P4A-I16 browser contract test: the acceptance runner's isolated delivery
 * step loads over the PRODUCTION delivery host with a fixture byte store.
 *
 * CONTRACT / FAIL-CLOSED coverage — this is NOT the real acceptance (real R2
 * evidence is pending). Mirroring the I11 conventions, a real application page
 * on 127.0.0.1 (cookie + beacon + storage + service worker) triggers
 * downloads of active HTML/JS, SVG, and a PDF polyglot from the isolated
 * delivery origin on 127.0.0.2. DevTools-observable network facts (status,
 * attachment/nosniff/no-store headers, byte counts), page execution, cookie
 * jar, storage, and service-worker scope are authoritative. This is the
 * browser half of the runner's `deliverOwner` step: headers are attachment
 * with nosniff/private-no-store, no Set-Cookie, no redirect, and the
 * side-effect markers never execute or connect back.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import { createHmacOwnerDeliveryCapabilitySigner } from '../../../src/modules/attachments/index.js';
import { composeDeliveryHost } from '../../../src/bootstrap/delivery.js';
import {
  BrowserAppOrigin,
  runI11BrowserScenario,
} from '../../../scripts/evidence/phase4a-i11-browser-scenario.js';
import {
  FixtureDeliveryObjectStore,
  I11_OWNER_A,
  I11_OWNER_B,
  activeHtmlBytes,
  fixtureKey,
  fixtureResolver,
  i11Config,
  issueCapability,
  polyglotPdfBytes,
  svgBytes,
  type I11FixtureObject,
} from '../../support/phase4a-i11-test-helpers.js';

const SECRET = Buffer.from('i16-browser-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');
const FILENAME = 'payload.bin';

describe('P4A-I16 delivery-step browser contract (fixture store; NOT the real acceptance)', () => {
  test('the isolated delivery step serves attachment headers/markers and never executes active content', async () => {
    const app = new BrowserAppOrigin();
    const cookieName = 'known_session';
    const cookieValue = `i16-session-${randomUUID()}`;
    const appOrigin = await app.start(cookieName, cookieValue);

    const markerHtml = `i16-html-${randomUUID()}`;
    const markerSvg = `i16-svg-${randomUUID()}`;
    const markerPolyglot = `i16-polyglot-${randomUUID()}`;

    const htmlObject: I11FixtureObject = {
      blobId: '018f6f7a-8f2a-7a3d-a123-123456789201',
      generationId: '018f6f7a-8f2a-7a3d-a123-123456789202',
      key: fixtureKey('i16-browser-html'),
      ownerSubject: I11_OWNER_A,
      bytes: activeHtmlBytes(markerHtml, `${appOrigin}/beacon?marker=${markerHtml}`),
      etag: '"i16-etag-browser-html"',
    };
    const svgObject: I11FixtureObject = {
      blobId: '018f6f7a-8f2a-7a3d-a123-123456789203',
      generationId: '018f6f7a-8f2a-7a3d-a123-123456789204',
      key: fixtureKey('i16-browser-svg'),
      ownerSubject: I11_OWNER_A,
      bytes: svgBytes(markerSvg, `${appOrigin}/beacon?marker=${markerSvg}`),
      etag: '"i16-etag-browser-svg"',
    };
    const polyglotObject: I11FixtureObject = {
      blobId: '018f6f7a-8f2a-7a3d-a123-123456789205',
      generationId: '018f6f7a-8f2a-7a3d-a123-123456789206',
      key: fixtureKey('i16-browser-polyglot'),
      ownerSubject: I11_OWNER_B,
      bytes: polyglotPdfBytes(markerPolyglot, `${appOrigin}/beacon?marker=${markerPolyglot}`),
      etag: '"i16-etag-browser-polyglot"',
    };
    const objects = [htmlObject, svgObject, polyglotObject];

    const store = new FixtureDeliveryObjectStore();
    for (const object of objects) store.seed(object);

    const host = await composeDeliveryHost({
      config: i11Config(),
      objectStore: store,
      capabilitySecret: SECRET,
      resolveGeneration: fixtureResolver(objects),
      hostname: '127.0.0.2',
    });
    const deliveryOrigin = await host.start();
    const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: SECRET, audienceOrigin: deliveryOrigin });
    try {
      const paths = objects.map((object) => `/d/${issueCapability(signer, object)}?filename=${encodeURIComponent(FILENAME)}`);
      const expectedByteCounts = objects.map((object) => object.bytes.byteLength);
      assert.notEqual(expectedByteCounts[0], expectedByteCounts[2], 'same-filename principals must have different bytes');

      const result = await runI11BrowserScenario({
        hosts: { appOrigin, deliveryOrigin, cookieName, cookieValue },
        objects: objects.map((object, index) => ({
          deliveryPath: paths[index]!,
          marker: [markerHtml, markerSvg, markerPolyglot][index]!,
          kind: index === 0 ? 'active-html' : index === 1 ? 'svg' : 'polyglot-pdf',
          expectedByteCount: expectedByteCounts[index]!,
        })),
        beaconHits: async (marker: string) => app.beaconHits(marker),
        getDeliveryResponseLog: () => host.requestLog,
      });

      assert.equal(result.originsDistinct, true, 'delivery origin must differ from the app origin host');
      assert.equal(result.downloadNavigations, 3, 'all three objects must be download navigations');

      const downloadResponses = result.deliveryResponses.slice(0, objects.length);
      assert.equal(downloadResponses.length, 3);
      for (const response of downloadResponses) {
        assert.equal(response.status, 200);
        assert.ok(response.headers['content-disposition']?.startsWith('attachment;'), 'forced download disposition');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['cache-control'], 'private,no-store');
        assert.equal(response.headers['content-type'], 'application/octet-stream');
        assert.equal('set-cookie' in response.headers, false, 'the isolated origin must never set a cookie');
        assert.equal(response.headers.location, undefined, 'never redirect to an R2 URL');
      }
      assert.deepEqual(result.deliveryByteCounts, expectedByteCounts, 'each principal receives its own exact byte count');

      assert.equal(result.markersExecuted, 0, 'active content markers must never execute or connect back');
      assert.deepEqual(result.executionMarkersInDom, [], 'no marker may mutate any application DOM');
      assert.deepEqual(result.pageContainsMarker, [], 'no marker may appear in any rendered page');

      assert.equal(result.appCookiePresentAtAppOrigin, true, 'sanity: the app cookie must exist on the app origin');
      assert.equal(result.appCookieReceivedAtIsolatedOrigin, false, 'the app cookie must never reach the isolated origin');
      assert.equal(result.isolatedStorageEmpty, true, 'the isolated origin must have no storage');
      assert.equal(result.isolatedServiceWorkerCount, 0, 'the isolated origin must have no service worker scope');
      assert.match(result.chromiumVersion, /^\d+(\.\d+){2,3}$/);
    } finally {
      await host.close();
      await app.close();
    }
  });
});
