/**
 * P4A-R06 Chromium projection-exclusion suite (Playwright Chromium).
 *
 * Runs the app-origin consumer surfaces (public collection page + search
 * page, rendered from the gate-wired production consumer entries) in real
 * Chromium while a REAL private-blob fixture with a unique marker exists.
 * The control resource is visible in the DOM (the consumer link executed) and
 * the private marker is absent from the DOM and from every same-origin
 * network response body — for `stored_private/active` and
 * `attached_private/retired` fixtures (retired/expired/quarantined states are
 * covered by the PostgreSQL suites; the browser surface adds the
 * network-observable proof).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  runI12BrowserProjectionScenario,
  type I12BrowserProjectionFixture,
} from '../../../scripts/evidence/phase4a-i12-browser-scenario.js';

describe('P4A-R06 browser projection exclusion (Playwright Chromium)', () => {
  test('public collection + search pages serve the control resource and never expose the private blob marker', async () => {
    const fixture: I12BrowserProjectionFixture = {
      collectionId: 'r06-browser-collection',
      collectionTitle: 'r06-browser-control-collection-title',
      nodeId: 'r06-browser-node',
      nodeTitle: 'r06-browser-control-node-title',
      controlMarker: 'r06-browser-control-node-title',
      privateMarker: 'r06-browser-private-blob-marker',
      privateBlobFacts: Object.freeze({
        blobId: 'r06-browser-private-blob',
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

  test('the app origin must never render the private marker for an attached_private/retired blob', async () => {
    const fixture: I12BrowserProjectionFixture = {
      collectionId: 'r06-browser-collection-2',
      collectionTitle: 'r06-browser-control-collection-title-2',
      nodeId: 'r06-browser-node-2',
      nodeTitle: 'r06-browser-control-node-title-2',
      controlMarker: 'r06-browser-control-node-title-2',
      privateMarker: 'r06-browser-private-blob-marker-2',
      privateBlobFacts: Object.freeze({
        blobId: 'r06-browser-private-blob-2',
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
