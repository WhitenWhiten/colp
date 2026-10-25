import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { COMMUNITY_RISK } from '../src/site-adapters/community-package.js';

type Catalog = Record<string, { message: string }>;
const en = JSON.parse(readFileSync(resolve(import.meta.dirname, '../_locales/en/messages.json'), 'utf8')) as Catalog;

// The Site adapters page shows the worker's package warning through the copy catalog; a change to one must reach the other.
test('the Site adapters page warns with the same words the worker sends with a package preview', () => {
  assert.equal(en.sites_communityRisk?.message, COMMUNITY_RISK);
});
