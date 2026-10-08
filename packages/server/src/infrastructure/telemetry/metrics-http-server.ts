import { createServer, type Server } from 'node:http';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface PrometheusMetricsServerOptions {
  readonly metrics: { renderPrometheus(): string };
  readonly host?: string;
  readonly port?: number;
}

export interface PrometheusMetricsServer {
  start(): Promise<{ readonly host: string; readonly port: number }>;
  close(): Promise<void>;
}

/** A dependency-free, scrape-only endpoint for non-HTTP processes such as the worker. */
export function createPrometheusMetricsServer(
  options: PrometheusMetricsServerOptions,
): PrometheusMetricsServer {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9_464;
  assertMetricsPort(port, true);
  let server: Server | undefined;

  return {
    async start() {
      if (server) return serverAddress(server, host);
      const candidate = createServer((request, response) => {
        const path = request.url?.split('?', 1)[0] ?? '';
        if ((request.method === 'GET' || request.method === 'HEAD') && path === '/metrics') {
          const body = options.metrics.renderPrometheus();
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': PROMETHEUS_CONTENT_TYPE,
            'content-length': Buffer.byteLength(body),
          });
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }
        if (request.method === 'GET' && path === '/health') {
          response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
          response.end('ok\n');
          return;
        }
        response.writeHead(404, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
      });
      candidate.requestTimeout = 5_000;
      candidate.headersTimeout = 5_000;
      candidate.keepAliveTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          candidate.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          candidate.off('error', onError);
          resolve();
        };
        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(port, host);
      });
      server = candidate;
      return serverAddress(candidate, host);
    },
    async close() {
      const current = server;
      server = undefined;
      if (!current) return;
      await new Promise<void>((resolve, reject) => {
        current.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export function parseMetricsPort(raw: string | undefined, fallback = 9_464): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw new Error('WORKER_METRICS_PORT must be an integer');
  const parsed = Number(raw);
  assertMetricsPort(parsed);
  return parsed;
}

function assertMetricsPort(port: number, allowEphemeral = false): void {
  if (!Number.isSafeInteger(port) || port < (allowEphemeral ? 0 : 1) || port > 65_535) {
    throw new Error('WORKER_METRICS_PORT must be between 1 and 65535');
  }
}

function serverAddress(server: Server, fallbackHost: string): { readonly host: string; readonly port: number } {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('metrics server address is unavailable');
  return { host: address.address || fallbackHost, port: address.port };
}
