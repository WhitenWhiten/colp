// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { classificationErrorFeedback, paintClassificationError } from '../src/classification-error-feedback.js';
import { localClassificationFailure } from '../src/classification-local-failure.js';
import { ClassificationError, ClassificationProviderError } from '../src/generated/classification/index.js';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test.each(['local_key_required', 'local_key_rejected'])('%s provides a direct route to the current service settings', async error => {
  const create = vi.fn().mockResolvedValue({});
  vi.stubGlobal('chrome', { tabs: { create }, runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` } });
  const host = document.createElement('p'); document.body.append(host);
  paintClassificationError(host, classificationErrorFeedback(error, true));
  expect(host.textContent).toContain('AI suggestions in settings');
  expect(host.textContent).not.toContain('Account');
  const button = host.querySelector('button')!; expect(button.textContent).toBe('Open AI service settings'); button.click();
  expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://fixture/options.html#ai' });
});

test('an uncertain server result retains same-request guidance and own-service errors never send users to sign-in', () => {
  expect(classificationErrorFeedback(undefined, false, true).text).toContain('Check this same request');
  expect(classificationErrorFeedback('reconnect_required', true).text).toContain('choose a folder manually');
  expect(classificationErrorFeedback('__proto__', true).text).toContain('choose a folder manually');
});

test('a received but invalid answer is distinguished from an unavailable provider', () => {
  for (const error of [new ClassificationError('contract_drift'), new ClassificationProviderError('contract_drift')]) {
    const code = localClassificationFailure(error);
    expect(code).toBe('local_request_failed');
    expect(classificationErrorFeedback(code, true).text).toContain('unexpected format');
    expect(classificationErrorFeedback(code, true).text).not.toContain("didn't answer");
  }
});

test('rate limiting, deadlines and interrupted results keep their recovery guidance', () => {
  expect(classificationErrorFeedback(localClassificationFailure(new ClassificationProviderError('rate_limited')), true).text).toContain('rate limited');
  expect(classificationErrorFeedback(localClassificationFailure(new ClassificationProviderError('deadline')), true).text).toContain('timed out');
  expect(classificationErrorFeedback(localClassificationFailure(new ClassificationProviderError('outcome_unknown')), true).text).toContain("wasn't received");
  expect(classificationErrorFeedback(localClassificationFailure(new ClassificationError('context_limit')), true).text).toContain('too large');
});
