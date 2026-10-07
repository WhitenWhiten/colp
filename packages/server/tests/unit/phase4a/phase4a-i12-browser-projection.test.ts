/**
 * P4A-I12 Chromium projection-exclusion suite (Playwright Chromium).
 *
 * Loads app-origin consumer surfaces (public collection page + search page)
 * while a REAL private-blob fixture with a unique marker exists. The pages are
 * rendered from REAL production consumer entries (publication metadata +
 * directory + search query) with fixture read ports, and the page's attachment
 * section only renders blobs the exposure-eligibility gate approves.
 *
 * DevTools-observable facts are authoritative: the control resource is visible
 * in the DOM (the consumer link executed), the private marker is ABSENT from
 * the DOM and from every same-origin network response body, and a search for
 * the exact private marker returns no result while the control search still
 * works.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  runI12BrowserProjectionScenario,
  type I12BrowserProjectionFixture,
} from '../../../scripts/evidence/phase4a-i12-browser-scenario.js';

describe('P4A-I12 browser projection exclusion (Playwright Chromium)', () => {
  test('public collection + search pages serve the control resource and never expose the private blob marker', async () => {
    const fixture: I12BrowserProjectionFixture = {
      collectionId: 'i12-browser-collection',
      collectionTitle: 'i12-browser-control-collection-title',
      nodeId: 'i12-browser-node',
      nodeTitle: 'i12-browser-control-node-title',
      controlMarker: 'i12-browser-control-node-title',
      privateMarker: 'i12-browser-private-blob-marker',
      privateBlobFacts: Object.freeze({
        blobId: 'i12-browser-private-blob',
        logicalState: 'stored_private',
        currentGenerationState: 'active',
      }),
    };
    const result = await runI12BrowserProjectionScenario(fixture);

    assert.equal(result.pagesLoaded, 2, 'both app-origin consumer surfaces must load');
    assert.equal(result.controlCollectionVisibleInDom, true, 'control collection must be visible (link executed)');
    assert.equal(result.controlNodeVisibleInDom, true, 'control node must be visible (link executed)');
    assert.deepEqual(result.privateMarkerInDom, [], 'private marker must never appear in any page DOM');
    assert.deepEqual(result.privateMarkerInResponses, [], 'private marker must never appear in any network response body');
    assert.ok(result.responseCount >= 2, 'page HTML responses must be observed over DevTools');
    assert.match(result.chromiumVersion, /^\d+(\.\d+){2,3}$/);
  });

  test('the app origin must never render the private marker even when asked directly for it', async () => {
    const fixture: I12BrowserProjectionFixture = {
      collectionId: 'i12-browser-collection-2',
      collectionTitle: 'i12-browser-control-collection-title-2',
      nodeId: 'i12-browser-node-2',
      nodeTitle: 'i12-browser-control-node-title-2',
      controlMarker: 'i12-browser-control-node-title-2',
      privateMarker: 'i12-browser-private-blob-marker-2',
      privateBlobFacts: Object.freeze({
        blobId: 'i12-browser-private-blob-2',
        logicalState: 'attached_private',
        currentGenerationState: 'retired',
      }),
    };
    const result = await runI12BrowserProjectionScenario(fixture);
    assert.equal(result.controlCollectionVisibleInDom, true);
    assert.deepEqual(result.privateMarkerInDom, [], 'attached_private/retired blob must never render');
    assert.deepEqual(result.privateMarkerInResponses, []);
  });
});
