import { AuthorityFencedError } from '../authority-fence.js';
export interface AutomationEvaluationIssue { readonly stage: 'account' | 'pause' | 'browser'; readonly code: string }
export class AutomationEvaluationUnavailable extends Error {
  readonly issue: AutomationEvaluationIssue;
  constructor(stage: AutomationEvaluationIssue['stage'], cause: unknown) {
    super('automation_unavailable', { cause });
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : cause instanceof Error ? cause.message : null;
    this.issue = { stage, code: typeof code === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/u.test(code) ? code : 'operation_failed' };
  }
}
/** Failure withdraws automatic placement permission; it is never a non-match. */
export async function readAutomationEvaluation<T>(stage: AutomationEvaluationIssue['stage'], read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { if (error instanceof AuthorityFencedError) throw error; throw new AutomationEvaluationUnavailable(stage, error); }
}
