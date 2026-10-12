import { expect, test } from 'vitest';
import { readClassificationProbeJson as read, CLASSIFICATION_PROBE_MAX_RESPONSE_BYTES as MAX } from '../src/classification-probe-response.js';

const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
function streamed(chunks: string[], options: { close?: boolean; cancel?: () => void | Promise<void>; headers?: Record<string, string> } = {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.close !== false) controller.close();
    },
    cancel: options.cancel,
  }), { headers: options.headers });
}

test('probe reads successful streamed JSON without using unbounded Response.json', async () => {
  const response = streamed(['{"model":', '"test","ok":true}']);
  response.json = () => { throw new Error('must not call Response.json'); };
  await expect(read(response, signal())).resolves.toEqual({ model: 'test', ok: true });
  expect(response.body!.locked).toBe(false);
});

test('probe accepts exactly 64 KiB and rejects one more byte from actual chunks', async () => {
  const source = '"' + 'x'.repeat(MAX - 2) + '"';
  expect(encoder.encode(source).length).toBe(MAX);
  await expect(read(streamed([source.slice(0, 100), source.slice(100)]), signal())).resolves.toHaveLength(MAX - 2);
  let cancelled = false;
  const response = streamed([source, 'x'], { close: false, cancel() { cancelled = true; } });
  await expect(read(response, signal())).rejects.toBeInstanceOf(RangeError);
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test('oversized Content-Length cancels before acquiring a reader', async () => {
  let cancelled = false;
  const response = streamed([], { close: false, cancel() { cancelled = true; }, headers: { 'content-length': String(MAX + 1) } });
  await expect(read(response, signal())).rejects.toBeInstanceOf(RangeError);
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test('probe does not trust a small Content-Length or count Unicode characters instead of bytes', async () => {
  let cancelled = false;
  const response = streamed(['"' + '雪'.repeat(Math.floor(MAX / 3)) + '"'], {
    close: false, cancel() { cancelled = true; }, headers: { 'content-length': '1' },
  });
  await expect(read(response, signal())).rejects.toBeInstanceOf(RangeError);
  expect(cancelled).toBe(true);
});

test('stalled probe aborts without awaiting a hanging cancellation callback', async () => {
  let cancelled = false;
  const controller = new AbortController(), reason = new Error('deadline');
  const response = streamed(['{"model":'], { close: false, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const pending = read(response, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test('a deadline that elapsed before body admission still cancels the response', async () => {
  let cancelled = false;
  const controller = new AbortController(), reason = new Error('already expired');
  controller.abort(reason);
  const response = streamed([], { close: false, cancel() { cancelled = true; } });
  await expect(read(response, controller.signal)).rejects.toBe(reason);
  expect(cancelled).toBe(true);
});

test('malformed JSON and missing bodies remain failures', async () => {
  await expect(read(new Response('{invalid'), signal())).rejects.toBeInstanceOf(SyntaxError);
  await expect(read(new Response(null), signal())).rejects.toBeInstanceOf(TypeError);
});
