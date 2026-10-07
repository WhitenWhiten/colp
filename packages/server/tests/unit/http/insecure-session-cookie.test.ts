import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { redactSensitiveText } from '../../../src/infrastructure/telemetry/index.js';
import {
  buildSessionSetCookie,
  clearSessionCookie,
  setSessionCookie,
} from '../../../src/transport/session-cookie.js';

afterEach(() => {
  delete process.env.COLP_INSECURE_HTTP;
});

describe('session cookie writer', () => {
  test('rotation and logout use known_session without Secure on insecure HTTP', () => {
    process.env.COLP_INSECURE_HTTP = 'true';
    const headers: string[] = [];
    const reply = {
      header(_name: string, value: string) {
        headers.push(value);
        return this;
      },
    };
    setSessionCookie(reply as never, 'rotated-token', new Date(Date.now() + 60_000));
    clearSessionCookie(reply as never);
    assert.match(headers[0] ?? '', /^known_session=rotated-token;/);
    assert.doesNotMatch(headers[0] ?? '', /Secure/);
    assert.match(headers[1] ?? '', /^known_session=;/);
    assert.match(headers[1] ?? '', /Max-Age=0/);
    assert.doesNotMatch(headers[1] ?? '', /Secure/);
  });

  test('TLS rotation and logout stay on the host cookie', () => {
    const set = buildSessionSetCookie('token', { maxAgeSeconds: 60 });
    const cleared = buildSessionSetCookie('', { maxAgeSeconds: 0, clear: true });
    assert.match(set, /^__Host-known_session=/);
    assert.match(set, /Secure/);
    assert.match(cleared, /^__Host-known_session=/);
    assert.match(cleared, /Secure/);
  });

  test('redacts a bare known_session value', () => {
    assert.equal(
      redactSensitiveText('cookie known_session=secret-value'),
      'cookie known_session=[REDACTED]',
    );
  });
});
