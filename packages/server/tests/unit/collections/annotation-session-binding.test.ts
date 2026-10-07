import { expect, test, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProductActor } from '../../../src/transport/session-auth.js';
import { bindAnnotationSession } from '../../../src/transport/product/annotation-session-binding.js';
const origin = `chrome-extension://${'a'.repeat(32)}`;
const actor = { account: {}, session: { id: 'verified-session' } } as ProductActor;
const request = (headers: Record<string, string>) => ({ headers } as FastifyRequest);
const reply = () => ({ header: vi.fn() } as unknown as FastifyReply);
test('Extension reads and mutations reject missing or rotated sessions before admission', () => {
  for (const headers of [{ origin }, { origin, 'known-annotation-session': 'other-session' }]) {
    expect(() => bindAnnotationSession(request(headers), reply(), actor)).toThrow('The browser session changed.');
  }
  const response = reply();
  bindAnnotationSession(request({ origin, 'known-annotation-session': 'verified-session' }), response, actor);
  expect(response.header).toHaveBeenCalledWith('Known-Annotation-Session', 'verified-session');
});
test('existing Web and Product bearer callers retain their admission; bearer cannot impersonate a bound cookie session', () => {
  bindAnnotationSession(request({}), reply(), actor);
  bindAnnotationSession(request({}), reply(), { account: {} } as ProductActor);
  expect(() => bindAnnotationSession(request({ 'known-annotation-session': 'verified-session' }), reply(),
    { account: {} } as ProductActor)).toThrow('The browser session changed.');
});
