import { expect, test, vi } from 'vitest';
import { validCaptureNavigation } from '../src/sw/capture-navigation.js';

// Only the request validator is under test; the worker modules it imports need a live extension runtime.
vi.mock('../src/sw/scope.js', () => ({}));
vi.mock('../src/sw/runtime.js', () => ({}));
vi.mock('../src/sw/capture-native.js', () => ({}));

test('the service worker accepts every pane the router can write and nothing else', () => {
  for (const hash of ['#history', '#history?task=12345678-1234-4123-8123-123456789abc', '#saving', '#ai', '#general', '#help?category=capture', '#account', '#account/credits',
    '#subscriptions/list', '#sync/center', '#bookmarks', '#native-wait-settings']) {
    expect(validCaptureNavigation({ kind: 'known.capture.navigation.set', hash }), hash).toBe(true);
  }
  for (const hash of ['#preferences', '#diagnostics', '#unknown', 'history', '#history\n']) {
    expect(validCaptureNavigation({ kind: 'known.capture.navigation.set', hash }), hash).toBe(false);
  }
});
