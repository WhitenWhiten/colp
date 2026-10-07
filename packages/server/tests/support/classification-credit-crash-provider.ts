import { createBookmarkClassificationProvider } from '../../src/infrastructure/collections/classification-provider-factory.js';
import type { BookmarkClassificationProvider } from '../../src/modules/collections/index.js';

/** Counts the authorized external-call callback, including cached-stage recovery. */
export function creditCrashProvider(onCall: () => Promise<void>): BookmarkClassificationProvider {
  return { ...createBookmarkClassificationProvider(null), async classify(context, execution) {
    const answer = { folderId: null, confidence: 1, probabilities: [
      { folderId: null, probability: 1 }, ...context.candidates!.l1.map(folder => ({ folderId: folder.id, probability: 0 })),
    ] };
    await execution.calls.run('l1', 0, { fixture: 'credit-crash' }, async () => {
      await onCall();
      return { answer, modelVersion: 'fixture', inputTokens: 1, outputTokens: 1 };
    });
    return { l1: answer, l2: null, tags: [], candidateCoverage: context.candidates!.coverage, modelVersion: 'fixture' };
  } };
}
