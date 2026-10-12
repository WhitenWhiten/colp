import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  HTTP_ORIGIN_REFUSED,
  HTTP_ORIGIN_UNENCRYPTED_WARNING,
  httpOriginConfirmation,
  isLoopbackHttpHost,
} from '../src/http-origin.js';

describe('HTTP server origins (COLP loopback-only HTTP)', () => {
  test('the three loopback names need one confirmation', () => {
    for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://LOCALHOST']) {
      assert.equal(httpOriginConfirmation(origin), 'loopback', origin);
    }
    assert.match(HTTP_ORIGIN_UNENCRYPTED_WARNING, /unencrypted/);
  });

  test('every other http host is refused, private ranges included', () => {
    for (const origin of [
      'http://192.168.1.20', 'http://10.1.2.3', 'http://172.16.0.1', 'http://127.0.0.2',
      'http://app.localhost', 'http://[fd12:3456::abcd]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]',
      'http://8.8.8.8', 'http://colp.example.net', 'http://router.local',
    ]) {
      assert.equal(httpOriginConfirmation(origin), 'refused', origin);
    }
    assert.match(HTTP_ORIGIN_REFUSED, /tls-internal/);
  });

  test('https needs no warning dialog', () => {
    assert.equal(httpOriginConfirmation('https://colp.example.net'), 'https');
    assert.equal(httpOriginConfirmation('https://192.168.1.20'), 'https');
  });

  test('loopback matching uses URL.hostname, which keeps IPv6 brackets', () => {
    assert.equal(isLoopbackHttpHost(new URL('http://[::1]:3000').hostname), true);
    assert.equal(isLoopbackHttpHost('::1'), false);
  });
});
