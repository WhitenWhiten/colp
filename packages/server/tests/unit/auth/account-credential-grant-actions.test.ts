import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  grantActionsCoverScopes,
  scopesForGrantActions,
} from '../../../src/modules/auth/application/account-credentials/grant-actions.js';

test('grant actions map to the frozen native scopes', () => {
  assert.deepEqual(scopesForGrantActions(['collection.content.write']), ['nodes:write']);
  assert.deepEqual(scopesForGrantActions(['collection.publish']), ['access:write']);
  assert.deepEqual(scopesForGrantActions(['report.issue.publish']), ['reports:publish', 'reports:write']);
  assert.equal(grantActionsCoverScopes(['collection.publish'], ['access:write']), true);
  assert.equal(grantActionsCoverScopes(['collection.content.write'], ['access:write']), false);
});
