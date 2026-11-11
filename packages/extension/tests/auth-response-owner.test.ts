import { expect, test } from 'vitest';
import { responseBelongsToAuthUser } from '../src/auth-response-owner.js';

test.each(['Known-Activity-Account-Id', 'Known-Automation-Account-Id'])('%s stays a business id while the auth-user header owns the response', header => {
  const response = new Response(null, { headers: { [header]: 'business-account', 'Known-Auth-User-Id': 'auth-user' } });
  expect(responseBelongsToAuthUser(response, 'auth-user', header)).toBe(true);
  expect(responseBelongsToAuthUser(response, 'business-account', header)).toBe(false);
  expect(responseBelongsToAuthUser(response, 'other-auth-user', header)).toBe(false);
  for (const headers of [{}, { [header]: 'other' }, { [header]: '', 'Known-Auth-User-Id': '' }]) {
    expect(responseBelongsToAuthUser(new Response(null, { headers }), 'auth-user', header)).toBe(false);
  }
  expect(responseBelongsToAuthUser(new Response(null, { headers: { [header]: 'legacy-owner' } }), 'legacy-owner', header)).toBe(true);
  expect(responseBelongsToAuthUser(new Response(null, { headers: { [header]: '', 'Known-Auth-User-Id': '' } }), '', header)).toBe(false);
});
