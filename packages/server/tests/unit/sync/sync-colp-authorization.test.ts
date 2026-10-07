import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { colpAuthorizationFromRawHeaders } from '../../../src/transport/colp-sync/sync-colp-authorization.js';

const TOKEN = 'baSessionToken.abc+def/ghi==';

describe('COLP authorization admission', () => {
  test('prefers a decoded session cookie over a mangled Authorization field', () => {
    const admitted = colpAuthorizationFromRawHeaders(new Map([
      ['cookie', [`__Host-known_session=${encodeURIComponent(TOKEN)}`]],
      ['authorization', [`Bearer ${encodeURIComponent(TOKEN)}-not-the-cookie`]],
    ]));
    assert.deepEqual(admitted, { authorization: `Bearer ${TOKEN}` });
  });

  test('denies two Cookie fields instead of first-wins', () => {
    const admitted = colpAuthorizationFromRawHeaders(new Map([
      ['cookie', ['other=1', `__Host-known_session=${encodeURIComponent(TOKEN)}`]],
      ['authorization', ['Bearer mangled']],
    ]));
    assert.deepEqual(admitted, { denial: 'invalid_json' });
  });

  test('denies a duplicate session cookie pair in one Cookie field', () => {
    assert.deepEqual(colpAuthorizationFromRawHeaders(new Map([
      ['cookie', [`__Host-known_session=a; __Host-known_session=${encodeURIComponent(TOKEN)}`]],
      ['authorization', [`Bearer ${TOKEN}`]],
    ])), { denial: 'invalid_json' });
  });

  test('denies malformed percent-encoding and never uses the raw garbage as Bearer', () => {
    for (const garbage of ['%zz', '%ZZ', '%E0%A4%A']) {
      const admitted = colpAuthorizationFromRawHeaders(new Map([
        ['cookie', [`__Host-known_session=${garbage}`]],
        ['authorization', [`Bearer ${TOKEN}`]],
      ]));
      assert.deepEqual(admitted, { denial: 'invalid_json' }, garbage);
      assert.notDeepEqual(admitted, { authorization: `Bearer ${garbage}` }, garbage);
    }
  });

  test('falls back to a single Authorization field when Cookie is absent', () => {
    const admitted = colpAuthorizationFromRawHeaders(new Map([
      ['authorization', [`Bearer ${TOKEN}`]],
    ]));
    assert.deepEqual(admitted, { authorization: `Bearer ${TOKEN}` });
  });

  test('falls back to Authorization when the Cookie field has no session cookie', () => {
    const admitted = colpAuthorizationFromRawHeaders(new Map([
      ['cookie', ['theme=dark']],
      ['authorization', [`Bearer ${TOKEN}`]],
    ]));
    assert.deepEqual(admitted, { authorization: `Bearer ${TOKEN}` });
  });

  test('denies missing credentials and duplicate Authorization', () => {
    assert.deepEqual(colpAuthorizationFromRawHeaders(new Map()), { denial: 'authentication_required' });
    assert.deepEqual(colpAuthorizationFromRawHeaders(new Map([
      ['authorization', [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]],
    ])), { denial: 'invalid_json' });
  });
});
