import { createHmac } from 'node:crypto';
import type { VisitorHashPort } from '../../modules/publication/index.js';

/**
 * HMAC-SHA-256 visitor identity for Publishing Insights (PI-01).
 *
 * Pepper is injected by the caller. PI-02 wires `PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY`.
 * Previous keys are intentionally unsupported: rotation resets visitor identity.
 */
export function createVisitorHashPort(pepper: Uint8Array): VisitorHashPort {
  const key = Buffer.from(pepper);
  return Object.freeze({
    hashAnonymous(cookie: string): Uint8Array {
      return digest(key, `anon|${cookie}`);
    },
    hashSubject(subjectId: string): Uint8Array {
      return digest(key, `subject|${subjectId}`);
    },
  });
}

function digest(pepper: Buffer, message: string): Uint8Array {
  return createHmac('sha256', pepper).update(message, 'utf8').digest();
}
