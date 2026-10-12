import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validRequest } from '../src/sw/messages.js';

const username = 'alice';

test('password login accepts a username; OTP still requires an email', () => {
  assert.equal(validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'password', email: username, password: 'secret',
  }), true);
  assert.equal(validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'password', email: 'alice@example.com', password: 'secret',
  }), true);
  assert.equal(validRequest({
    kind: 'known.auth.send-otp', userGesture: true, email: username,
  }), false);
  assert.equal(validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'otp', email: username, otp: '123456',
  }), false);
  assert.equal(validRequest({
    kind: 'known.auth.send-otp', userGesture: true, email: 'alice@example.com',
  }), true);
  assert.equal(validRequest({
    kind: 'known.auth.login', userGesture: true, method: 'otp', email: 'alice@example.com', otp: '123456',
  }), true);
});
