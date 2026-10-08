/**
 * P4A-I06 controlled fault transport for the adapter contract suite.
 *
 * This is a REAL local HTTP/1.1 server: every request is a genuine HTTP
 * exchange through the production `@aws-sdk` middleware and `NodeHttpHandler`
 * (the S3 client simply points its `endpoint` at this server). It is NOT an
 * emulator (no S3 semantics), NOT a Map, and NOT a command mock — the test
 * asserts the recorded raw request (method, path, headers, body) to prove the
 * fault actually reached the transport before asserting the stable class.
 *
 * The server can script raw responses: status/headers/body, multi-chunk
 * streaming bodies, mid-body socket destruction (connection interruption),
 * and connection drops without a response.
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { waitForCondition, waitForRealTime } from './async-test-helpers.js';

export interface RecordedRequest {
  readonly method: string;
  /** Raw request target including the query string. */
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

export interface ScriptedChunk {
  readonly data: string | Buffer;
  readonly delayMs?: number;
}

export interface FaultScriptResult {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** Stream the body as multiple chunks with optional inter-chunk delays. */
  readonly chunks?: readonly ScriptedChunk[];
  /** Write this many bytes of `body`, then reset the socket mid-body (RST). */
  readonly destroyAfterBytes?: number;
  /** Destroy the socket without sending any response (connection drop). */
  readonly dropConnection?: boolean;
  /** Write `chunks` but never end the response (client must close it). */
  readonly holdOpen?: boolean;
}

export type FaultScript = (
  request: RecordedRequest,
  index: number,
) => FaultScriptResult | Promise<FaultScriptResult>;

export interface FaultServer {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** Responses the client destroyed before the server finished writing. */
  readonly prematurelyClosed: number;
  /**
   * Waits until the server has observed at least one premature close (client
   * destroyed the body mid-write) or the timeout elapses, then returns the
   * current counter. The close event is delivered asynchronously after the
   * client destroys its socket, so tests should await this instead of reading
   * `prematurelyClosed` immediately.
   */
  waitForPrematureClose(timeoutMs?: number): Promise<number>;
  close(): Promise<void>;
}

async function collectBody(request: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of request) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export async function startFaultServer(script: FaultScript): Promise<FaultServer> {
  const requests: RecordedRequest[] = [];
  let prematurelyClosedCount = 0;
  const server = createServer(async (request, response) => {
    let destroyed = false;
    response.on('close', () => {
      if (!response.writableEnded) prematurelyClosedCount += 1;
      destroyed = true;
    });
    const body = await collectBody(request);
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      body,
    };
    const index = requests.length;
    requests.push(recorded);
    let result: FaultScriptResult;
    try {
      result = await script(recorded, index);
    } catch {
      request.socket.destroy();
      return;
    }
    if (result.dropConnection) {
      request.socket.destroy();
      return;
    }
    const payload = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? '');
    response.writeHead(result.status, result.headers ?? {});
    if (result.chunks && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        if (destroyed) return;
        if (chunk.delayMs) {
          await waitForRealTime(chunk.delayMs, 'inject a scripted fault-response chunk delay');
        }
        if (destroyed) return;
        response.write(chunk.data);
      }
      if (result.holdOpen !== true && !destroyed) response.end();
      return;
    }
    if (result.destroyAfterBytes !== undefined && payload.length > 0) {
      response.write(payload.subarray(0, Math.min(payload.length, result.destroyAfterBytes)));
      await waitForRealTime(10, 'allow the scripted partial response to reach the client before reset');
      if (typeof request.socket.resetAndDestroy === 'function') {
        request.socket.resetAndDestroy();
      } else {
        request.socket.destroy();
      }
      return;
    }
    if (result.holdOpen === true) {
      // Never end the response: the client must destroy the connection
      // (timeout/abort) for the exchange to finish.
      return;
    }
    if (!destroyed) response.end(payload);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get prematurelyClosed() {
      return prematurelyClosedCount;
    },
    waitForPrematureClose: async (timeoutMs = 2000) => {
      await waitForCondition(() => prematurelyClosedCount > 0, {
        timeoutMs,
        description: 'the fault-server client connection to close prematurely',
      });
      return prematurelyClosedCount;
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** Convenience: an XML S3-style error body for service errors. */
export function s3ErrorBody(code: string, message = code): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}
