import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bench, describe } from 'vitest';

import { planPublicationSnapshotDelivery } from '../../src/server/publication-snapshot-delivery-policy.js';
import type { Snapshot } from '../../src/types/index.js';

const snapshot = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-snapshot.json'),
  'utf8',
)) as Snapshot;
const input = Object.freeze({
  classification: 'dynamic' as const,
  query: Object.freeze({}),
  snapshot,
});

describe('publication snapshot delivery baseline', () => {
  bench('plans a complete dynamic snapshot', () => {
    planPublicationSnapshotDelivery(input);
  });
});
