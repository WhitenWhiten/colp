import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  createLinkPreviewEgressFixture,
  LINK_PREVIEW_EGRESS_FIXTURE_ENV,
  linkPreviewEgressFromEnv,
} from '../../../src/infrastructure/collections/index.js';

const document = JSON.stringify({
  pin: '93.184.216.34',
  routes: { 'https://lp.example.test/page': { contentType: 'text/html', bodyBase64: Buffer.from('<p>hi</p>').toString('base64') } },
});

test('routes answer their scripted bytes and everything else 404s', async () => {
  const egress = createLinkPreviewEgressFixture(document);
  assert.deepEqual(await egress.resolve('lp.example.test'), ['93.184.216.34']);
  const hit = await egress.connect({ url: new URL('https://lp.example.test/page'), ip: '93.184.216.34', family: 4 }, {});
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'text/html');
  assert.equal(await hit.text(), '<p>hi</p>');
  const miss = await egress.connect({ url: new URL('https://lp.example.test/other'), ip: '93.184.216.34', family: 4 }, {});
  assert.equal(miss.status, 404);
});

test('the env seam is off without the variable and refused in production', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lp-egress-')), 'fixture.json');
  writeFileSync(path, document);
  assert.equal(linkPreviewEgressFromEnv({}, 'test'), undefined);
  assert.ok(linkPreviewEgressFromEnv({ [LINK_PREVIEW_EGRESS_FIXTURE_ENV]: path }, 'test'));
  assert.throws(() => linkPreviewEgressFromEnv({ [LINK_PREVIEW_EGRESS_FIXTURE_ENV]: path }, 'production'), /not allowed in production/u);
});
