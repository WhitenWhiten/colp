/**
 * P4A-P05 local S3-subset object server (test-owned, not a vitest test file).
 *
 * A REAL local HTTP/1.1 server with create-only PUT, exact-key HEAD
 * (conditional If-Match), exact-key GET (conditional If-Match, bounded body
 * read) and exact-key DELETE, plus per-key fault/delay scripting for HEAD and
 * GET. The PRODUCTION R2 adapter is pointed at this server, so the Product
 * issue grant is signed by the real `@aws-sdk` presigner, the independent
 * HTTP client PUTs through the real transport, and the PRODUCTION worker
 * verification route reads the exact generation through the real adapter.
 *
 * Abort hardening: the P05 suites abort responses mid-write (worker
 * stop/drain, SIGKILL, provider timeout). The handler attaches an 'error'
 * listener to the response AND the request stream and rethrows nothing past
 * the invocation catch, so a client that destroys its socket while a delayed
 * response is being written can never surface as an uncaught exception in the
 * server process.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitForRealTime } from './async-test-helpers.js';
import { sha256Hex } from './phase4a-p03-test-helpers.js';

export interface P05RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

export interface P05StoredObject {
  readonly etag: string;
  readonly size: number;
  readonly contentType: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

/**
 * Real HTTP transport stand-in for the R2 endpoint with the FULL surface the
 * production worker needs: create-only PUT (real presigned grant), exact-key
 * HEAD with conditional If-Match, exact-key GET with conditional If-Match
 * (bounded body read), and exact-key DELETE. Per-key HEAD/GET fault and delay
 * scripting makes provider-timeout / retryable / abort windows deterministic.
 */
export class P05ObjectServer {
  readonly objects = new Map<string, P05StoredObject>();
  readonly requests: P05RecordedRequest[] = [];
  /** Exact keys whose HEAD must fail with a retryable 500. */
  readonly headFailures = new Set<string>();
  /** Exact keys whose HEAD response must be delayed (ms). */
  readonly headDelays = new Map<string, number>();
  /** Exact keys whose GET must fail with a retryable 500. */
  readonly readFailures = new Set<string>();
  /** Exact keys whose GET response must be delayed (ms). */
  readonly readDelays = new Map<string, number>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(() => undefined);
  });
  url = '';

  async start(): Promise<string> {
    await new Promise<void>((resolvePromise) => this.server.listen(0, '127.0.0.1', resolvePromise));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  keyCount(): number {
    return this.objects.size;
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    // Client aborts (worker stop/drain, crash, timeout) destroy the socket
    // while a delayed response is still being written; never let that surface
    // as an uncaught 'error' on the response stream.
    response.on('error', () => undefined);
    // A client that resets the connection mid-request (aborted PUT body)
    // emits 'error' on the request stream; consume it so the for-await body
    // read below fails through the invocation catch instead of crashing the
    // server process.
    request.on('error', () => undefined);
    const parts: Buffer[] = [];
    for await (const chunk of request) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(parts);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);
    const key = segments.slice(1).join('/');
    const method = request.method ?? '';
    this.requests.push({ method, path: request.url ?? '', headers: request.headers, body });

    if (method === 'PUT') {
      if (this.objects.has(key)) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const contentType = request.headers['content-type'];
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.startsWith('x-amz-meta-') && typeof value === 'string') {
          metadata[name.slice('x-amz-meta-'.length)] = value;
        }
      }
      const etag = `"${sha256Hex(body).slice(0, 32)}"`;
      this.objects.set(key, {
        etag,
        size: body.byteLength,
        contentType: typeof contentType === 'string' ? contentType : null,
        metadata: Object.freeze(metadata),
        body,
      });
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }

    if (method === 'HEAD') {
      if (this.headFailures.has(key)) {
        response.writeHead(500, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const delay = this.headDelays.get(key);
      if (delay !== undefined && delay > 0) {
        await waitForRealTime(delay, 'inject P05 object-store HEAD latency');
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        ETag: object.etag,
        'Content-Length': String(object.size),
        'Content-Type': object.contentType ?? 'application/octet-stream',
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }

    if (method === 'GET') {
      if (this.readFailures.has(key)) {
        response.writeHead(500, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const delay = this.readDelays.get(key);
      if (delay !== undefined && delay > 0) {
        await waitForRealTime(delay, 'inject P05 object-store GET latency');
      }
      const object = this.objects.get(key);
      if (!object) {
        response.writeHead(404, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch === 'string' && ifMatch !== object.etag) {
        response.writeHead(412, { 'Content-Length': '0' });
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        ETag: object.etag,
        'Content-Length': String(object.size),
        'Content-Type': object.contentType ?? 'application/octet-stream',
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      response.end(object.body);
      return;
    }

    if (method === 'DELETE') {
      const deleted = this.objects.delete(key);
      response.writeHead(deleted ? 204 : 404, { 'Content-Length': '0' });
      response.end();
      return;
    }

    response.writeHead(405, { 'Content-Length': '0' });
    response.end();
  }
}
