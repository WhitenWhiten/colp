// Transport/evidence adapter only. This sentence is an explicit fixture, not an inferred summary.
export const supports = task => task.type === 'summary.generate' && task.outputContract === 'summary.sourced.v1';
export async function generate({ inputs }) {
  return { output: { kind: 'text', textType: 'summary', text: 'Deterministic reference-worker fixture.', language: 'en',
    evidence: inputs.map(input => ({ kind: 'source', reference: input.sourceEventId, observedAt: new Date().toISOString() })) }, modelLabel: 'deterministic-fixture' };
}
