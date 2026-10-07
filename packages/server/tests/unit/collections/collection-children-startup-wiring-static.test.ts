/**
 * FO-05/FO-07 formal startup wiring contract.
 *
 * The `/api/v1/collections/{collectionId}/children` route is only registered
 * when `buildApiApp` receives `collectionChildrenReadUnitOfWork`. The postgres
 * port factory creates and exports it, and the integration tests inject it
 * directly — so a missing forward in `src/bootstrap/api.ts` made every
 * created/created sort fall back to curated in the real deployment while all
 * in-repo integration tests stayed green. This pins the production call.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';

const BACKEND_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function read(relative: string): string {
  return readFileSync(resolve(BACKEND_ROOT, relative), 'utf8');
}

describe('FO-05 collection children formal startup wiring', () => {
  test('api.ts forwards collectionChildrenReadUnitOfWork into buildApiApp', () => {
    const api = read('src/bootstrap/api.ts');
    assert.match(
      api,
      /collectionChildrenReadUnitOfWork:\s*ports\.collectionChildrenReadUnitOfWork/u,
      'the real API bootstrap must pass the children read unit of work; without it '
      + 'the /children route is never registered and created sorts silently fall back to curated',
    );
  });

  test('postgres ports still create and export the children read unit of work', () => {
    const ports = read('src/bootstrap/api-postgres-ports.ts');
    assert.match(ports, /createPostgresCollectionChildrenReadUnitOfWork\(/u);
    assert.match(ports, /^\s*collectionChildrenReadUnitOfWork,$/mu);
  });

  test('the route registers only when the enabled flag and the port are both present', () => {
    const surfaces = read('src/transport/register-product-surfaces.ts');
    assert.match(surfaces, /registerCollectionChildrenRoutes\(app,\s*\{/u);
    assert.match(surfaces, /enabled:\s*config\.faviconPolicy\.enabled/u);
    assert.match(surfaces, /childrenReadUnitOfWork:\s*collectionChildrenReadUnitOfWork/u);
  });
});
