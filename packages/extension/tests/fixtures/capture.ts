import type { CaptureLocation, CaptureTask } from '../../src/capture/contracts.js';

export const location: CaptureLocation = { collectionId: 'c', collectionTitle: 'Library', nodeId: 'n', nativeId: '1',
  path: ['Library', 'Folder'], writable: true, url: 'https://example.org/?id=1#section' };
export const task: CaptureTask = { version: 1, captureId: 'capture', commandId: 'command', batchId: null,
  scope: { accountId: 'a', serverOrigin: 'https://known.test', authorityGeneration: 1, collectionId: 'c' },
  source: 'action-popup', tabId: 1, url: location.url, title: 'Page', targetNativeId: 'folder',
  insertPosition: 'bottom', saveAnother: false, allowUnverifiedCloud: true, createdAt: 0, updatedAt: 0,
  revision: 0, policyVersion: 'v1', automaticIntent: true, disposition: 'new', save: 'unsubmitted',
  classification: 'waiting', sync: 'pending', existence: null, nativeIntentId: null, nativeId: null,
  nodeId: null, executionId: null, decisionId: null, localLocation: null, cloudLocation: null,
  appliedRevision: null, manualFence: 0, controlGeneration: 0, reason: null };
