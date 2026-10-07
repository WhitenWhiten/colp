import assert from 'node:assert/strict';
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { test } from 'vitest';
import {
  charsetFromContentType,
  charsetFromMeta,
  decodeReadableReplicaBody,
  ReadableReplicaBodyEncodingError,
  ReadableReplicaBodyTooLargeError,
} from '../../../src/infrastructure/collections/index.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const supportsGbk = (() => {
  try {
    return new TextDecoder('gbk').encoding === 'gbk';
  } catch {
    return false;
  }
})();
// "中文" in GBK.
const GBK_ZHONGWEN = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);

function decode(bytes: Uint8Array, contentType: string | null, contentEncoding: string | null = null): string {
  return decodeReadableReplicaBody({ bytes, contentType, contentEncoding, maxBytes: 65_536 });
}

test('charset parameter parsing tolerates quotes, spacing and case', () => {
  assert.equal(charsetFromContentType('text/html; charset=UTF-8'), 'UTF-8');
  assert.equal(charsetFromContentType('text/html;charset="gb2312"'), 'gb2312');
  assert.equal(charsetFromContentType('Text/HTML ; Charset = Shift_JIS'), 'Shift_JIS');
  assert.equal(charsetFromContentType('text/html'), null);
  assert.equal(charsetFromContentType(null), null);
});

test('meta charset sniffing reads both meta forms from the first 2 KiB only', () => {
  assert.equal(charsetFromMeta(utf8('<html><head><meta charset="gbk"><title>x</title>')), 'gbk');
  assert.equal(charsetFromMeta(utf8(
    '<html><head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">',
  )), 'windows-1252');
  assert.equal(charsetFromMeta(utf8(`<html><head>${'<!-- pad -->'.repeat(200)}<meta charset="gbk">`)), null);
  assert.equal(charsetFromMeta(utf8('<html><head><meta charset="utf-16">')), 'utf-8');
  assert.equal(charsetFromMeta(utf8('<html><head></head>')), null);
});

test('utf-8 stays the default and a leading BOM is honoured', () => {
  assert.equal(decode(utf8('<p>héllo 中文</p>'), 'text/html'), '<p>héllo 中文</p>');
  assert.equal(decode(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('<p>bom</p>')]), 'text/html'), '<p>bom</p>');
});

test('latin-1 pages decode through the header charset instead of producing replacement characters', () => {
  const latin1 = Uint8Array.from([...utf8('<p>caf'), 0xe9, ...utf8('</p>')]);
  assert.equal(decode(latin1, 'text/html; charset=iso-8859-1'), '<p>café</p>');
  assert.equal(decode(latin1, 'text/html').includes('\ufffd'), true);
});

test.skipIf(!supportsGbk)('GBK pages decode via header charset or <meta charset>; header wins over meta', () => {
  const metaGbk = Uint8Array.from([...utf8('<html><head><meta charset="gbk"></head><body><p>'), ...GBK_ZHONGWEN, ...utf8('</p>')]);
  assert.equal(decode(metaGbk, 'text/html').includes('<p>中文</p>'), true);
  assert.equal(decode(GBK_ZHONGWEN, 'text/html; charset=GB2312'), '中文');
  const metaGbkBodyUtf8 = utf8('<meta charset="gbk"><p>中文</p>');
  assert.equal(decode(metaGbkBodyUtf8, 'text/html; charset=utf-8'), '<meta charset="gbk"><p>中文</p>');
});

test('unknown and replacement-only charset labels fall back to utf-8 instead of throwing', () => {
  assert.equal(decode(utf8('<p>ok 中</p>'), 'text/html; charset=x-not-a-real-charset'), '<p>ok 中</p>');
  assert.equal(decode(utf8('<p>ok 中</p>'), 'text/html; charset=hz-gb-2312'), '<p>ok 中</p>');
  assert.equal(decode(utf8('<meta charset="bogus-label"><p>ok</p>'), 'text/html'), '<meta charset="bogus-label"><p>ok</p>');
});

test('gzip, deflate (zlib and raw) and brotli bodies are inflated before decoding', () => {
  const html = '<html><body><p>compressed 中文 body</p></body></html>';
  assert.equal(decode(gzipSync(html), 'text/html; charset=utf-8', 'gzip'), html);
  assert.equal(decode(gzipSync(html), 'text/html', 'x-gzip'), html);
  assert.equal(decode(deflateSync(html), 'text/html', 'deflate'), html);
  assert.equal(decode(deflateRawSync(html), 'text/html', 'deflate'), html);
  assert.equal(decode(brotliCompressSync(html), 'text/html', 'br'), html);
  assert.equal(decode(utf8(html), 'text/html', 'identity'), html);
  assert.equal(decode(gzipSync(brotliCompressSync(html)), 'text/html', 'br, gzip'), html);
});

test('inflation is bounded by maxBytes and unsupported or corrupt encodings fail closed', () => {
  const big = gzipSync('<p>' + 'a'.repeat(200_000) + '</p>');
  assert.throws(
    () => decodeReadableReplicaBody({ bytes: big, contentType: 'text/html', contentEncoding: 'gzip', maxBytes: 65_536 }),
    ReadableReplicaBodyTooLargeError,
  );
  assert.throws(() => decode(utf8('<p>x</p>'), 'text/html', 'zstd'), ReadableReplicaBodyEncodingError);
  assert.throws(() => decode(utf8('not gzip at all'), 'text/html', 'gzip'), ReadableReplicaBodyEncodingError);
  assert.throws(() => decode(utf8('not brotli'), 'text/html', 'br'), ReadableReplicaBodyEncodingError);
});
