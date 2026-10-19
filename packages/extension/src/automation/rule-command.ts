import type { BrowserRuleResponse } from './messages.js';

/** One command to the worker's rule list (messages.ts BrowserRuleCommand); a worker that is gone answers `unavailable`. */
export function sendRuleCommand(message: object): Promise<BrowserRuleResponse> {
  return chrome.runtime.sendMessage(message).then((reply) => reply as BrowserRuleResponse ?? { ok: false, error: 'unavailable' },
    () => ({ ok: false, error: 'unavailable' }));
}
