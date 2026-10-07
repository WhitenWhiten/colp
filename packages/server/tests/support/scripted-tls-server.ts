import { once } from 'node:events';
import { createServer } from 'node:https';
import type { ServerResponse } from 'node:http';
import { readEmailEntryFixtureTls } from '../../scripts/evidence/phase5-email-entry-fixture.js';
import { waitForCondition } from './async-test-helpers.js';

/**
 * Local TLS server for scripted HTTPS responses (FIX-L-060 byte-limit tests).
 *
 * The server writes exactly what the test handler scripted and records whether
 * the client aborted the response before it finished: `closedBeforeFinish`
 * becomes true when the connection was released (client destroyed the
 * response at its byte limit) before the server could complete the body.
 */
export interface ScriptedTlsServerStats {
  readonly finished: boolean;
  readonly closedBeforeFinish: boolean;
}

export interface ScriptedTlsServer {
  readonly origin: string;
  readonly stats: ScriptedTlsServerStats;
  close(): Promise<void>;
}

/**
 * Waits (bounded) until the server-side response has either finished or been
 * closed early by the client. The client's socket destroy propagates to the
 * server asynchronously (a loopback round trip of a few milliseconds), so
 * assertions about early close must wait for the server-side 'close' event
 * instead of checking immediately after the client promise settles.
 */
export async function waitForServerResponseSettle(
  server: ScriptedTlsServer,
  timeoutMs = 2_000,
): Promise<void> {
  await waitForCondition(
    () => server.stats.finished || server.stats.closedBeforeFinish,
    {
      timeoutMs,
      description: 'the scripted TLS response to finish or close',
    },
  );
}

export async function startScriptedTlsServer(
  handle: (response: ServerResponse) => Promise<void>,
): Promise<ScriptedTlsServer> {
  const tls = readEmailEntryFixtureTls();
  const stats: ScriptedTlsServerStats = { finished: false, closedBeforeFinish: false };
  const server = createServer({ cert: tls.cert, key: tls.key }, (_request, response) => {
    response.on('error', () => {
      // Client aborted mid-response (byte-limit enforcement); expected.
    });
    response.on('finish', () => {
      stats.finished = true;
    });
    response.on('close', () => {
      if (!stats.finished) stats.closedBeforeFinish = true;
    });
    void handle(response).catch(() => {
      // Client aborted mid-response (byte-limit enforcement); expected.
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind scripted TLS server');
  }
  return {
    origin: `https://127.0.0.1:${address.port}`,
    stats,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/**
 * Writes a body with drain-based backpressure so an early client abort
 * interrupts the write loop instead of being absorbed by socket buffers.
 */
export async function streamBodyWithBackpressure(response: ServerResponse, body: string): Promise<void> {
  const chunkBytes = 16 * 1024;
  try {
    for (let offset = 0; offset < body.length; offset += chunkBytes) {
      if (response.destroyed) return;
      const chunk = body.slice(offset, offset + chunkBytes);
      if (!response.write(chunk)) await once(response, 'drain');
    }
    response.end();
  } catch {
    // Client aborted the response; the byte-limit test owns the assertion.
  }
}
