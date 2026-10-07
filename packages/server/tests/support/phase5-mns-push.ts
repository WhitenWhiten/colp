import {
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

/**
 * Shared Phase 5 test fixtures for the legacy Aliyun MNS HTTP push callback
 * path. Test-only: builds a real RSA keypair-backed self-signed X.509
 * certificate (so the adapter's real MNS RSA-SHA1 verification path runs end
 * to end) and an independent string-to-sign builder following the official
 * MNS doc format.
 */

/** Aliyun-owned signing-certificate URL accepted by the adapter allowlist. */
export const MNS_TEST_CERT_URL = 'https://mns-cert.oss-cn-hangzhou.aliyuncs.com/x509_public_certificate.pem';

// ---------------------------------------------------------------------------
// Minimal DER X.509 self-signed certificate builder (test-only). Node has no
// certificate creation API, so the fixture constructs a valid certificate for
// a freshly generated RSA keypair to exercise the real MNS RSA-SHA1 path.
// ---------------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(...parts: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(parts));
}

function derSet(...parts: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(parts));
}

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) start += 1;
  return derTag(0x02, bytes.subarray(start));
}

function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  const first = parts[0]! * 40 + parts[1]!;
  const bytes: number[] = [first];
  for (const part of parts.slice(2)) {
    const stack: number[] = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...stack);
  }
  return derTag(0x06, Buffer.from(bytes));
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derUtf8String(value: string): Buffer {
  return derTag(0x0c, Buffer.from(value, 'utf8'));
}

function derName(commonName: string): Buffer {
  return derSequence(derSet(derSequence(derOid('2.5.4.3'), derUtf8String(commonName))));
}

function derUtcTime(date: Date): Buffer {
  const two = (value: number): string => String(value).padStart(2, '0');
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return derTag(0x17, Buffer.from(text, 'ascii'));
}

function derBitString(content: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0]), content]));
}

function derExplicit(tag: number, content: Buffer): Buffer {
  return derTag(tag, content);
}

function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString('base64');
  const lines = base64.match(/.{1,64}/gu) ?? [base64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function createSelfSignedTestCertificate(keypair: {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}): string {
  const notBefore = new Date(Date.now() - 24 * 3_600_000);
  const notAfter = new Date(Date.now() + 365 * 24 * 3_600_000);
  const sha1AlgorithmId = derSequence(derOid('1.2.840.113549.1.1.5'), derNull());
  const name = derName('Known MNS Test Certificate');
  const spki = keypair.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = derSequence(
    derExplicit(0xa0, derInteger(2n)),
    derInteger(1n),
    sha1AlgorithmId,
    name,
    derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
    name,
    spki,
  );
  const signature = cryptoSign('RSA-SHA1', tbs, keypair.privateKey);
  return derToPem(derSequence(tbs, sha1AlgorithmId, derBitString(signature)), 'CERTIFICATE');
}

// ---------------------------------------------------------------------------
// Independent MNS string-to-sign builder following the official doc format.
// CanonicalizedResource = URI path + query excluding host/port. Absolute URLs
// are normalized via URL; relative request targets (the real ingress) are
// preserved as received (percent-encoding untouched).
// ---------------------------------------------------------------------------

function independentCanonicalizedResource(url: string): string {
  const withoutFragment = url.split('#', 1)[0] ?? url;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/u.test(withoutFragment)) {
    const parsed = new URL(withoutFragment);
    return `${parsed.pathname}${parsed.search}`;
  }
  return withoutFragment;
}

export function buildMnsStringToSignFixture(input: {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}): string {
  const contentMd5 = input.headers['content-md5'] ?? '';
  const contentType = input.headers['content-type'] ?? '';
  const date = input.headers['date'] ?? input.headers['x-mns-date'] ?? '';
  const canonicalHeaders = Object.keys(input.headers)
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith('x-mns-'))
    .sort()
    .map((name) => `${name}:${input.headers[name]}`)
    .join('\n');
  return [input.method, contentMd5, contentType, date, canonicalHeaders, independentCanonicalizedResource(input.url)]
    .join('\n');
}

// ---------------------------------------------------------------------------
// Signed MNS HTTP push request fixture (body + headers + relative/absolute
// request target), signed over the same string the adapter will verify.
// ---------------------------------------------------------------------------

export interface MnsPushRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

export interface MnsPushRequestOverrides {
  readonly body?: string;
  readonly url?: string;
  readonly date?: string;
  readonly certUrl?: string;
  readonly tamperBodyAfterSigning?: boolean;
  /** Build/sign the push WITHOUT a Content-MD5 header (fail-closed coverage). */
  readonly omitContentMd5?: boolean;
  /** Override the signed Content-MD5 header value (integrity-check coverage). */
  readonly contentMd5?: string;
}

export const MNS_PUSH_DEFAULT_BODY = [
  'X-Notify-Message-ID=3121639760461824',
  'env_id=12625010655',
  'msg_id=ac349efc-0d79-489b-affa-f178dce3e49e@example.com',
  'account=sender@example.invalid',
  'from=sender@example.invalid',
  'rcpt=recipient@example.invalid',
  'recv_time=2026-08-02T00:00:00',
  'end_time=2026-08-02T00:00:01',
  'status=4',
  'event=deliver',
  'region=cn-hangzhou',
  'err_code=524',
  'err_msg=524 Host not found by dns resolve',
  'failed_type=SysOutDnsResolveFail',
].join('&');

export function buildMnsPushRequest(
  keypair: { readonly privateKey: KeyObject },
  overrides: MnsPushRequestOverrides = {},
): MnsPushRequest {
  const body = overrides.body ?? MNS_PUSH_DEFAULT_BODY;
  const url = overrides.url ?? 'https://mns.example/notifications?code=200';
  const headers: Record<string, string> = {
    'content-type': 'text/plain;charset=utf-8',
    date: overrides.date ?? new Date().toUTCString(),
    'x-mns-request-id': 'request-id-1',
    'x-mns-version': '2015-06-06',
    'x-mns-signing-cert-url': Buffer.from(overrides.certUrl ?? MNS_TEST_CERT_URL, 'utf8').toString('base64'),
  };
  // omitContentMd5 signs a push with NO Content-MD5 header (the string-to-sign
  // then carries an empty Content-MD5 slot, exactly like a real MD5-less push).
  if (overrides.omitContentMd5 !== true) {
    headers['content-md5'] = createHash('md5').update(body).digest('base64');
  }
  const stringToSign = buildMnsStringToSignFixture({ method: 'POST', url, headers });
  headers.authorization = cryptoSign('RSA-SHA1', Buffer.from(stringToSign, 'utf8'), keypair.privateKey)
    .toString('base64');
  // contentMd5 replaces the header AFTER signing, so the RSA signature stays
  // valid over the true MD5 while the on-the-wire header is wrong (exercises
  // the Content-MD5 integrity check, not the RSA check).
  if (overrides.contentMd5 !== undefined) {
    headers['content-md5'] = overrides.contentMd5;
  }
  if (overrides.tamperBodyAfterSigning === true) {
    return { body: `${body}&tampered=1`, headers, url };
  }
  return { body, headers, url };
}
