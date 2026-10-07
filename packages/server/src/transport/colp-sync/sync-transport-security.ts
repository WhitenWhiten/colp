import type { FastifyRequest } from 'fastify';
import {
  createTrustedIngressMatcher,
  type TrustedIngressPeerMatcher,
} from '../../bootstrap/trusted-ingress.js';

export interface SyncTransportSecurityOptions {
  readonly allowInsecureLoopback: boolean;
  /** Explicit TRUSTED_INGRESS allowlist; absent = no trusted socket peer. */
  readonly trustedIngress?: readonly string[];
}

export interface SyncTransportSecurity {
  /**
   * FIX-M-008: true only when the request carries acceptable TLS evidence —
   * real socket TLS, an opted-in loopback peer, or a socket peer inside the
   * explicit trusted-ingress allowlist carrying a forwarded https proto.
   * An untrusted socket peer can never forge `X-Forwarded-Proto` past this
   * gate, and `request.ip` (rate-limit keys) is separately Fastify
   * trust-gated so forwarded IPs also require an allowlisted peer.
   */
  isSecure(request: FastifyRequest): boolean;
}

/**
 * FIX-M-008 Sync transport TLS guard shared by every Sync route. The old
 * `request.protocol === 'https'` check trusted any socket peer's forwarded
 * proto whenever a numeric trustProxy (or a misconfigured trust function)
 * was in effect; this guard decides the evidence itself: socket TLS first,
 * then the explicit ingress allowlist + forwarded https, otherwise fail
 * closed. Real proxy TLS termination keeps working because the ingress
 * socket peer is allowlisted (the app must never rely on `socket.encrypted`
 * alone — a TLS-terminating proxy is a plaintext peer by design).
 */
export function createSyncTransportSecurity(
  options: SyncTransportSecurityOptions,
): SyncTransportSecurity {
  const trustedPeer: TrustedIngressPeerMatcher | undefined =
    options.trustedIngress === undefined || options.trustedIngress.length === 0
      ? undefined : createTrustedIngressMatcher(options.trustedIngress);
  return Object.freeze({
    isSecure(request: FastifyRequest) {
      // `encrypted` exists at runtime on TLS sockets only; narrow the net.Socket
      // type to the TLS marker (same cast the evidence harness uses).
      const socket = request.raw.socket as unknown as { readonly encrypted?: boolean };
      if (socket.encrypted === true) return true;
      const peer = request.raw.socket.remoteAddress?.toLowerCase();
      if (options.allowInsecureLoopback && isLoopbackPeer(peer)) return true;
      return trustedPeer !== undefined && trustedPeer(peer) && forwardedProtoIsHttps(request);
    },
  });
}

function isLoopbackPeer(peer: string | undefined): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

function forwardedProtoIsHttps(request: FastifyRequest): boolean {
  const proto = request.headers['x-forwarded-proto'];
  // Operators must overwrite (not append) X-Forwarded-Proto at the trusted
  // ingress. Multi-value arrays and comma lists fail closed.
  if (Array.isArray(proto)) {
    if (proto.length !== 1) return false;
    return isSingleHttpsToken(proto[0]);
  }
  return isSingleHttpsToken(proto);
}

function isSingleHttpsToken(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes(',')) return false;
  return trimmed.toLowerCase() === 'https';
}
