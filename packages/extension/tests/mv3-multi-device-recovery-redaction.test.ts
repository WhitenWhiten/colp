import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  containsPhase3Marker,
  domainSeparatedPhase3MetadataDigest,
  markerVariants,
  redactPhase3MarkerBytes,
} from '../scripts/phase3-marker-scan.mjs';
import {
  credentialTokenMetadata,
  redactUrl,
  secretMetadata,
} from '../e2e/mv3-multi-device-recovery-redaction.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('P3-38 recovery artifact redaction', () => {
  test('keeps every fail-closed marker representation detectable', () => {
    const marker = 'P3-38 confidential marker/value with spaces';
    const middle = Math.floor(marker.length / 2);
    const representations = [
      marker,
      marker.slice(0, middle),
      marker.slice(middle),
      encodeURIComponent(marker),
      Buffer.from(marker).toString('base64'),
      JSON.stringify(marker).slice(1, -1),
      sha(marker),
    ];

    expect(markerVariants([marker])).toEqual(expect.arrayContaining(representations));
    for (const representation of representations) {
      expect(containsPhase3Marker([marker], `prefix:${representation}:suffix`)).toBe(true);
    }
  });

  test('redacts marker bytes without changing surrounding binary data', () => {
    const marker = 'P3-38 confidential binary-marker';
    const prefix = Buffer.from([0xff, 0x00, 0x01, 0x80]);
    const suffix = Buffer.from([0xfe, 0x00, 0x7f, 0x81]);
    const raw = Buffer.concat([prefix, Buffer.from(marker), suffix]);
    const sanitized = redactPhase3MarkerBytes([marker], raw);

    expect(containsPhase3Marker([marker], raw.toString('utf8'))).toBe(true);
    expect(containsPhase3Marker([marker], sanitized.toString('utf8'))).toBe(false);
    expect(sanitized.subarray(0, prefix.length)).toEqual(prefix);
    expect(sanitized.subarray(-suffix.length)).toEqual(suffix);
    expect(sanitized.subarray(prefix.length, -suffix.length))
      .toEqual(Buffer.alloc(Buffer.byteLength(marker), 0x78));
    expect(raw.subarray(prefix.length, -suffix.length)).toEqual(Buffer.from(marker));
  });

  test('domain-separates stable field metadata from raw marker hashes', () => {
    const token = 'header.payload.signature-with-high-entropy';
    const tokenMetadata = credentialTokenMetadata(token, 'network-authorization-token');
    const subjectMetadata = secretMetadata(token, 'authority-credential-subject');

    expect(tokenMetadata).toEqual(credentialTokenMetadata(token, 'network-authorization-token'));
    expect(tokenMetadata).not.toEqual(credentialTokenMetadata(token, 'other-authorization-token'));
    expect(subjectMetadata).not.toEqual(secretMetadata(token, 'other-credential-subject'));
    expect(tokenMetadata).toMatchObject({ present: true, length: token.length, segments: 3 });
    expect(containsPhase3Marker([token], JSON.stringify(tokenMetadata))).toBe(false);
    expect(containsPhase3Marker([token], JSON.stringify(subjectMetadata))).toBe(false);
    expect(domainSeparatedPhase3MetadataDigest('network-authorization-token', token)).not.toBe(sha(token));
    expect(domainSeparatedPhase3MetadataDigest('network-authorization-token-first-segment', 'header'))
      .not.toBe(sha('header'));
  });

  test('retains fixed protocol routes but binds dynamic paths without exposing them', () => {
    const markerUrl = 'https://marker.invalid/0123456789abcdefabcd?token=secret#fragment';
    const redacted = redactUrl(markerUrl);

    expect(new URL(redacted).origin).toBe('https://marker.invalid');
    expect(new URL(redacted).pathname).toMatch(/^\/__redacted_path__\/[a-f0-9]{64}$/u);
    expect(redacted).not.toContain('0123456789abcdefabcd');
    expect(redacted).not.toContain('token=secret');
    expect(containsPhase3Marker(['/0123456789abcdefabcd'], new URL(redacted).pathname)).toBe(false);
    expect(redactUrl('https://runtime.invalid/colp/v0.1/sync/pull?cursor=private'))
      .toBe('https://runtime.invalid/colp/v0.1/sync/pull');
    expect(redactUrl('https://runtime.invalid/oauth2/token#private'))
      .toBe('https://runtime.invalid/oauth2/token');
  });
});
