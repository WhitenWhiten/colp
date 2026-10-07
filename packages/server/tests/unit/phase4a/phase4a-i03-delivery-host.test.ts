import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  DELIVERY_CAPABILITY_MAX_TTL_SECONDS,
  DELIVERY_CAPABILITY_MIN_TTL_SECONDS,
  DELIVERY_CAPABILITY_TTL_SECONDS,
  DELIVERY_MAX_EXPOSURE_WINDOW_SECONDS,
  DELIVERY_SECURITY_HEADERS,
  createDeliveryHost,
} from '../../../scripts/evidence/phase4a-i03-delivery-host.js';
import type { DeliveryHost } from '../../../scripts/evidence/phase4a-i03-delivery-host.js';
import {
  FixturePrivateStore,
  activeHtmlBytes,
  concatBytes,
  mutableClock,
  pdfBytes,
  pngBytes,
} from '../../support/phase4a-i03-test-helpers.js';
import {
  assertDeliveryOriginNotSameSite,
  registrableDomain,
} from '../../../src/modules/attachments/attachments-origin.js';

const FIXTURE_ROOT = resolve('tests/fixtures/phase4a');
const OWNER = 'subject:owner-1';

function seededStore(): FixturePrivateStore {
  const store = new FixturePrivateStore();
  store.seed({
    blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
    generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
    ownerSubject: OWNER,
    bytes: pdfBytes('delivery payload\n'),
    mediaType: 'application/pdf',
    category: 'allowlisted',
    etag: '"i03-etag-1"',
  });
  return store;
}

async function startedHost(store: FixturePrivateStore, clock = mutableClock()): Promise<{ host: DeliveryHost; origin: string }> {
  const host = createDeliveryHost({ store, appOrigin: 'http://127.0.0.1:9', clock: clock.now });
  const origin = await host.start();
  host.issuer.registerActiveGeneration('018f6f7a-8f2a-7a3d-a123-123456789001', '018f6f7a-8f2a-7a3d-a123-123456789002');
  return { host, origin };
}

async function issueOwner(host: DeliveryHost, ttlSeconds = DELIVERY_CAPABILITY_TTL_SECONDS): Promise<string> {
  const claims = host.issueForOwner({
    blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
    generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
    ownerSubject: OWNER,
    ttlSeconds,
  });
  return claims.capabilityId;
}

describe('P4A-I03 owner-private delivery reference host', () => {
  test('pins the capability/security-header contract fixture', async () => {
    const fixture = JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'i03-contract.json'), 'utf8')) as {
      capability: Record<string, unknown>; securityHeaders: Record<string, string>;
    };
    assert.equal(DELIVERY_CAPABILITY_MIN_TTL_SECONDS, fixture.capability.minTtlSeconds);
    assert.equal(DELIVERY_CAPABILITY_MAX_TTL_SECONDS, fixture.capability.maxTtlSeconds);
    assert.equal(DELIVERY_CAPABILITY_TTL_SECONDS, fixture.capability.defaultTtlSeconds);
    assert.equal(DELIVERY_MAX_EXPOSURE_WINDOW_SECONDS, fixture.capability.maxExposureWindowSeconds);
    assert.equal(fixture.capability.audienceBound, true);
    assert.equal(fixture.capability.containsR2Credential, false);
    assert.equal(fixture.capability.containsObjectKey, false);
    assert.equal(DELIVERY_SECURITY_HEADERS.contentDisposition, fixture.securityHeaders.contentDisposition);
    assert.equal(DELIVERY_SECURITY_HEADERS.xContentTypeOptions, fixture.securityHeaders.xContentTypeOptions);
    assert.equal(DELIVERY_SECURITY_HEADERS.cacheControl, fixture.securityHeaders.cacheControl);
    assert.equal(fixture.securityHeaders.setCookie, 'never');
  });

  test('the delivery origin is a distinct host/port from the Known app origin', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      assert.notEqual(new URL(origin).host, new URL('http://127.0.0.1:9').host);
      assert.notEqual(origin, 'http://127.0.0.1:9');
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await host.close();
    }
  });

  test('a valid owner capability returns exact bytes with exact security headers and no Set-Cookie', async () => {
    const store = seededStore();
    const { host, origin } = await startedHost(store);
    try {
      const capabilityId = await issueOwner(host);
      const response = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      const body = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(body, pdfBytes('delivery payload\n'));
    } finally {
      await host.close();
    }
  });

  test('empty objects deliver with zero body and content-length 0', async () => {
    const store = new FixturePrivateStore();
    store.seed({
      blobId: '018f6f7a-8f2a-7a3d-a123-123456789011',
      generationId: '018f6f7a-8f2a-7a3d-a123-123456789012',
      ownerSubject: OWNER,
      bytes: new Uint8Array(0),
      mediaType: 'application/octet-stream',
      category: 'unknown',
      etag: '"i03-etag-empty"',
    });
    const { host, origin } = await startedHost(store);
    try {
      host.issuer.registerActiveGeneration('018f6f7a-8f2a-7a3d-a123-123456789011', '018f6f7a-8f2a-7a3d-a123-123456789012');
      const capabilityId = host.issueForOwner({
        blobId: '018f6f7a-8f2a-7a3d-a123-123456789011',
        generationId: '018f6f7a-8f2a-7a3d-a123-123456789012',
        ownerSubject: OWNER,
      }).capabilityId;
      const response = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), '0');
      assert.equal(await response.text(), '');
    } finally {
      await host.close();
    }
  });

  test('suspicious active content is served only as generic octet-stream with forced download', async () => {
    const store = new FixturePrivateStore();
    store.seed({
      blobId: '018f6f7a-8f2a-7a3d-a123-123456789021',
      generationId: '018f6f7a-8f2a-7a3d-a123-123456789022',
      ownerSubject: OWNER,
      bytes: activeHtmlBytes('browser-marker'),
      mediaType: 'text/html',
      category: 'suspicious',
      etag: '"i03-etag-html"',
    });
    const { host, origin } = await startedHost(store);
    try {
      host.issuer.registerActiveGeneration('018f6f7a-8f2a-7a3d-a123-123456789021', '018f6f7a-8f2a-7a3d-a123-123456789022');
      const capabilityId = host.issueForOwner({
        blobId: '018f6f7a-8f2a-7a3d-a123-123456789021',
        generationId: '018f6f7a-8f2a-7a3d-a123-123456789022',
        ownerSubject: OWNER,
      }).capabilityId;
      const response = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await host.close();
    }
  });

  test('single ranges are served with 206 and exact Content-Range', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const headers = {};
      const base = `${origin}/d/${capabilityId}`;

      const first = await fetch(base, { headers: { ...headers, range: 'bytes=0-3' } });
      assert.equal(first.status, 206);
      assert.equal(first.headers.get('content-range'), `bytes 0-3/${pdfBytes('delivery payload\n').byteLength}`);
      assert.equal(await first.text(), '%PDF');

      const suffix = await fetch(base, { headers: { ...headers, range: 'bytes=-3' } });
      assert.equal(suffix.status, 206);
      assert.equal(await suffix.text(), 'OF\n');

      const openEnded = await fetch(base, { headers: { ...headers, range: 'bytes=2-' } });
      assert.equal(openEnded.status, 206);
      const body = await openEnded.text();
      assert.equal(body, new TextDecoder().decode(pdfBytes('delivery payload\n')).slice(2));
    } finally {
      await host.close();
    }
  });

  test('invalid, out-of-bounds and multi ranges are 416 with Content-Range and zero body', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const base = `${origin}/d/${capabilityId}`;
      const size = pdfBytes('delivery payload\n').byteLength;
      for (const range of ['bytes=999-1000', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=abc']) {
        const response = await fetch(base, { headers: { range } });
        assert.equal(response.status, 416, range);
        assert.equal(response.headers.get('content-range'), `bytes */${size}`, range);
        assert.equal(await response.text(), '', range);
        assert.equal(response.headers.get('cache-control'), 'private,no-store', range);
      }
    } finally {
      await host.close();
    }
  });

  test('unknown and forged capability ids are 404 with zero body', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      for (const path of ['/d/i03-00000000-0000-0000-0000-000000000000', '/d/not-a-capability']) {
        const response = await fetch(`${origin}${path}`, {});
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), '', path);
        assert.equal(response.headers.get('content-disposition'), 'attachment', path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
      }
    } finally {
      await host.close();
    }
  });

  test('expired capabilities are denied with zero body', async () => {
    const clock = mutableClock();
    const { host, origin } = await startedHost(seededStore(), clock);
    try {
      const capabilityId = await issueOwner(host, 1);
      clock.advance(2_000);
      const response = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 403);
      assert.equal(await response.text(), '');
    } finally {
      await host.close();
    }
  });

  test('revoked capabilities are denied immediately for all subsequent requests', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const before = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(before.status, 200);
      host.issuer.revoke(capabilityId);
      const after = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(after.status, 403);
      assert.equal(await after.text(), '');
    } finally {
      await host.close();
    }
  });

  test('replaying a capability for a replaced generation is denied with zero body', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const before = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(before.status, 200);
      host.issuer.replaceActiveGeneration(
        '018f6f7a-8f2a-7a3d-a123-123456789001',
        '018f6f7a-8f2a-7a3d-a123-123456789099',
      );
      const replayed = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(replayed.status, 403);
      assert.equal(await replayed.text(), '');
    } finally {
      await host.close();
    }
  });

  test('a non-owner who knows the blob/generation ids still gets zero body', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const blobId = '018f6f7a-8f2a-7a3d-a123-123456789001';
      const generationId = '018f6f7a-8f2a-7a3d-a123-123456789002';
      const directPaths = [
        `/d/${blobId}`, `/d/${generationId}`, `/d/${blobId}/${generationId}`,
        `/blob/${blobId}/body`, '/d/i03-00000000-0000-0000-0000-000000000000',
      ];
      for (const direct of directPaths) {
        const response = await fetch(`${origin}${direct}`);
        assert.equal(response.status, 404, direct);
        assert.equal(await response.text(), '', direct);
      }
      assert.equal(host.requestLog.every((entry) => entry.byteCount === 0), true);
    } finally {
      await host.close();
    }
  });

  test('anonymous requests without a capability are denied with zero body', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const anonymous = await fetch(`${origin}/d/i03-00000000-0000-0000-0000-000000000000`);
      assert.equal(anonymous.status, 404);
      assert.equal(await anonymous.text(), '');
      const root = await fetch(`${origin}/`);
      assert.equal(root.status, 404);
      assert.equal(await root.text(), '');
    } finally {
      await host.close();
    }
  });

  test('revocation before capability issuance refuses the capability; after issuance denies delivery', async () => {
    const store = seededStore();
    const { host, origin } = await startedHost(store);
    try {
      assert.throws(
        () => host.issueForOwner({
          blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
          generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
          ownerSubject: 'subject:revoked-before-issuance',
        }),
        /delivery_issue_not_current_owner/,
      );
      const capabilityId = await issueOwner(host);
      store.removeOwner('018f6f7a-8f2a-7a3d-a123-123456789001');
      const response = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 403);
      assert.equal(await response.text(), '');
    } finally {
      await host.close();
    }
  });

  test('Cookie and Authorization headers are never used or forwarded and no Set-Cookie is emitted', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const url = `${origin}/d/${capabilityId}`;
      const withCredentials = await fetch(url, {
        headers: {
          cookie: 'known_session=i03-app-cookie-marker',
          authorization: 'Bearer i03-app-token-marker',
        },
      });
      assert.equal(withCredentials.status, 200);
      assert.equal(withCredentials.headers.get('set-cookie'), null);
      assert.equal(await withCredentials.text(), new TextDecoder().decode(pdfBytes('delivery payload\n')));

      const without = await fetch(url, {});
      assert.equal(without.status, 200);
      assert.equal(without.headers.get('set-cookie'), null);

      const deliveryEntries = host.requestLog.filter((entry) => entry.status === 200);
      assert.ok(deliveryEntries.length >= 2);
      assert.equal(deliveryEntries[0]!.receivedCookies, true);
      assert.equal(deliveryEntries[0]!.receivedAuthorization, true);
      assert.equal(deliveryEntries[0]!.setCookies, false);
      assert.equal(deliveryEntries[1]!.receivedCookies, false);
      assert.equal(deliveryEntries[1]!.receivedAuthorization, false);
      assert.equal(deliveryEntries[1]!.setCookies, false);
    } finally {
      await host.close();
    }
  });

  test('capabilities are bound to one isolated delivery origin audience', async () => {
    const storeA = seededStore();
    const hostA = createDeliveryHost({ store: storeA, appOrigin: 'http://127.0.0.1:9' });
    const originA = await hostA.start();
    // hostB shares hostA's issuer (same capability claims registry) but listens
    // on its own origin, so the audience-bound check is the only thing that can
    // deny the request: a capability issued for originA must not be usable at
    // hostB's origin. Without a shared issuer the capability would simply be
    // unresolvable (404), which would not exercise the audience mechanism.
    const hostB = createDeliveryHost({
      store: storeA,
      appOrigin: 'http://127.0.0.1:9',
      issuer: hostA.issuer,
    });
    try {
      await hostB.start();
      hostA.issuer.registerActiveGeneration(
        '018f6f7a-8f2a-7a3d-a123-123456789001',
        '018f6f7a-8f2a-7a3d-a123-123456789002',
      );
      const capabilityId = await issueOwner(hostA);
      const response = await fetch(`${hostB.origin}/d/${capabilityId}`, {});
      assert.equal(response.status, 403);
      assert.equal(await response.text(), '');
      assert.notEqual(originA, hostB.origin);
    } finally {
      await hostA.close();
      await hostB.close();
    }
  });

  test('capability TTL validation enforces the bounded window', async () => {
    const { host } = await startedHost(seededStore());
    try {
      const claims = host.issueForOwner({
        blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
        generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
        ownerSubject: OWNER,
      });
      assert.equal(claims.expiresAtEpochMs - claims.issuedAtEpochMs, DELIVERY_CAPABILITY_TTL_SECONDS * 1000);
      assert.equal(host.issueForOwner({
        blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
        generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
        ownerSubject: OWNER,
        ttlSeconds: DELIVERY_CAPABILITY_MAX_TTL_SECONDS,
      }).expiresAtEpochMs - claims.issuedAtEpochMs, DELIVERY_CAPABILITY_MAX_TTL_SECONDS * 1000);
      assert.throws(
        () => host.issueForOwner({
          blobId: '018f6f7a-8f2a-7a3d-a123-123456789001',
          generationId: '018f6f7a-8f2a-7a3d-a123-123456789002',
          ownerSubject: OWNER,
          ttlSeconds: DELIVERY_CAPABILITY_MAX_TTL_SECONDS + 1,
        }),
        /delivery_capability_ttl_out_of_range/,
      );
    } finally {
      await host.close();
    }
  });

  test('cache isolation: every response is private,no-store with no cache validators', async () => {
    const { host, origin } = await startedHost(seededStore());
    try {
      const capabilityId = await issueOwner(host);
      const ok = await fetch(`${origin}/d/${capabilityId}`, {});
      assert.equal(ok.headers.get('cache-control'), 'private,no-store');
      assert.equal(ok.headers.get('etag'), null);
      assert.equal(ok.headers.get('last-modified'), null);
      assert.equal(ok.headers.get('expires'), null);

      host.issuer.revoke(capabilityId);
      const denied = await fetch(`${origin}/d/${capabilityId}`);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('cache-control'), 'private,no-store');
      assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(denied.headers.get('content-disposition'), 'attachment');
    } finally {
      await host.close();
    }
  });
});

describe('FIX-L-050 the same-site guard uses the full PSL (tldts eTLD+1, private suffixes included)', () => {
  test('private suffixes (github.io / appspot.com) define their own registrable domain', () => {
    assert.equal(registrableDomain('user.github.io'), 'user.github.io');
    assert.equal(registrableDomain('docs.user.github.io'), 'user.github.io');
    assert.equal(registrableDomain('foo.appspot.com'), 'foo.appspot.com');
    assert.notEqual(registrableDomain('user.github.io'), registrableDomain('foo.appspot.com'));
    // Different GitHub Pages users are different registrable domains, even
    // though the old last-two-labels heuristic collapsed both to github.io.
    assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('bob.github.io'));
  });

  test('ICANN compound suffixes keep the eTLD+1 boundary', () => {
    assert.equal(registrableDomain('a.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('a.example.org.uk'), 'example.org.uk');
    assert.notEqual(registrableDomain('a.example.co.uk'), registrableDomain('b.example.com'));
  });

  test('unknown TLDs fall back to the last two labels; single labels stay put', () => {
    assert.equal(registrableDomain('app.known.example'), 'known.example');
    assert.equal(registrableDomain('known.example'), 'known.example');
    assert.equal(registrableDomain('localhost'), 'localhost');
  });

  test('punycode (IDN) hostnames are classified by the full PSL', () => {
    assert.equal(registrableDomain('xn--fsqu00a.xn--0zwm56d'), 'xn--fsqu00a.xn--0zwm56d');
    assert.equal(registrableDomain('sub.xn--fsqu00a.xn--0zwm56d'), 'xn--fsqu00a.xn--0zwm56d');
    assert.equal(registrableDomain('xn--bcher-kva.example'), 'xn--bcher-kva.example');
    assert.notEqual(registrableDomain('xn--fsqu00a.xn--0zwm56d'), registrableDomain('xn--bcher-kva.example'));
  });

  test('trailing dots are normalized before comparison', () => {
    assert.equal(registrableDomain('example.com.'), 'example.com');
    assert.equal(registrableDomain('cdn.example.com.'), 'example.com');
    assert.equal(registrableDomain('a.example.co.uk.'), 'example.co.uk');
  });

  test('IPv4/IPv6 and IP:port forms are their own registrable domain', () => {
    assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
    assert.equal(registrableDomain('127.0.0.1:8080'), '127.0.0.1:8080');
    assert.equal(registrableDomain('::1'), '::1');
    assert.equal(registrableDomain('[::1]'), '[::1]');
    assert.notEqual(registrableDomain('127.0.0.1'), registrableDomain('127.0.0.2'));
  });

  test('same-site detection ignores port and honors the private-suffix boundary', () => {
    // Different GitHub Pages users are different sites (the old heuristic
    // collapsed both to github.io and rejected this valid deployment).
    assert.doesNotThrow(() => assertDeliveryOriginNotSameSite(
      'https://alice.github.io',
      'https://bob.github.io',
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    ));
    // The same registrable domain is rejected regardless of scheme port.
    assert.throws(
      () => assertDeliveryOriginNotSameSite(
        'https://app.example.com:8443',
        'https://delivery.example.com:9443',
        'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
      ),
      /must not be same-site with the Known application origin/u,
    );
    // Site semantics ignore port: the same IP on different ports is same-site.
    assert.throws(
      () => assertDeliveryOriginNotSameSite(
        'http://127.0.0.1:9',
        'http://127.0.0.1:4444',
        'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
      ),
      /must not be same-site with the Known application origin/u,
    );
    // Different IPs are different sites outside production.
    assert.doesNotThrow(() => assertDeliveryOriginNotSameSite(
      'http://127.0.0.1:9',
      'http://127.0.0.2:8080',
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    ));
  });

  test('production fails closed on IP addresses and unresolvable hostnames', () => {
    for (const delivery of ['https://127.0.0.3', 'https://[::1]:8443']) {
      assert.throws(
        () => assertDeliveryOriginNotSameSite(
          'https://app.example.com',
          delivery,
          'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
          true,
        ),
        /must not use an IP address/u,
        delivery,
      );
    }
    // Single-label and malformed hosts have no registrable domain: production
    // cannot prove a different site and must fail closed.
    for (const delivery of ['https://intranet', 'https://a..b']) {
      assert.throws(
        () => assertDeliveryOriginNotSameSite(
          'https://app.example.com',
          delivery,
          'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
          true,
        ),
        /cannot determine the registrable domain/u,
        delivery,
      );
    }
    // The same inputs remain usable outside production (loopback fixtures).
    assert.doesNotThrow(() => assertDeliveryOriginNotSameSite(
      'http://127.0.0.1:9',
      'http://127.0.0.2:8080',
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    ));
    assert.doesNotThrow(() => assertDeliveryOriginNotSameSite(
      'http://127.0.0.1:9',
      'http://intranet:8080',
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    ));
  });

  test('production accepts distinct DNS registrable domains and rejects same-site ones', () => {
    assert.doesNotThrow(() => assertDeliveryOriginNotSameSite(
      'https://app.known.example',
      'https://delivery.attachments-probe.invalid',
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
      true,
    ));
    assert.throws(
      () => assertDeliveryOriginNotSameSite(
        'https://app.known.example',
        'https://delivery.known.example',
        'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
        true,
      ),
      /must not be same-site with the Known application origin/u,
    );
  });
});


