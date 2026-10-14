import { useCallback, useEffect, useRef, useState } from 'react'
import { automationApi, type AutomationApi } from '../../api/automationClient'
import type { AutomationEffectReceipt, AutomationJob, AutomationRun } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import type { WriteApprovalView } from '../../api'
import { useToast } from '../../components/AppToast'

/* AU-19: automation plans wait in the same Approvals queue as agent plans.
   A plan's reason names its rule and job (`automation:<ruleId>:<jobId>`),
   but that text is untrusted, so a plan only counts as an automation plan
   once the Owner's own job view points back at the same planId. Decisions
   go through the job's decision command with the exact proposal digest and
   job revision; Undo is the run's effect receipt, never a version restore. */

const REFERENCE = /^automation:([A-Za-z0-9._~-]{1,128}):([A-Za-z0-9._~-]{1,128})$/u
/** Plans checked per page load; the queue lists at most 100. */
const MAX_PLANS = 50

export type AutomationPlan = {
  ruleId: string
  ruleName: string | null
  job: AutomationJob
  run: AutomationRun | null
  /** This plan's receipt in its run, once the plan committed. */
  effect: AutomationEffectReceipt | null
}

/* The server's automation summaries name one effect type; anything else is shown as written. */
const SUMMARIES: Record<string, string> = {
  'Automation: one reversible create_annotation effect.': 'Add a note to a bookmark',
  'Automation: one reversible update_node effect.': 'Change a bookmark’s tags',
  'Automation: one reversible move_node effect.': 'Move a bookmark',
}

export function automationSummary(summary: string): string {
  return SUMMARIES[summary] ?? summary
}

export function automationCandidate(approval: WriteApprovalView): { ruleId: string; jobId: string } | null {
  const match = REFERENCE.exec(approval.reason?.trim() ?? '')
  const [, ruleId, jobId] = match ?? []
  return ruleId && jobId ? { ruleId, jobId } : null
}

async function confirmPlan(api: AutomationApi, approval: WriteApprovalView, signal: AbortSignal): Promise<AutomationPlan | null> {
  const candidate = automationCandidate(approval)
  if (!candidate) return null
  const job = await api.getJob(candidate.jobId, signal)
  if (job.planId !== approval.planId) return null
  const [ruleName, run] = await Promise.all([
    api.getRule(candidate.ruleId, signal).then((rule) => rule.definition.name, () => null),
    api.getRun(job.runId, signal).catch(() => null),
  ])
  const effect = run?.effects.find((item) => item.kind === 'plan' && item.planId === approval.planId) ?? null
  return { ruleId: candidate.ruleId, ruleName, job, run, effect }
}

/** Confirmed automation plans by planId; anything unconfirmed stays an ordinary agent plan. */
export function useAutomationPlans(approvals: readonly WriteApprovalView[], api: AutomationApi = automationApi) {
  const [plans, setPlans] = useState<ReadonlyMap<string, AutomationPlan>>(new Map())
  const approvalsRef = useRef(approvals)
  approvalsRef.current = approvals
  // A decision or refresh changes the plan's etag, which re-reads its job and run.
  const key = approvals
    .filter((approval) => automationCandidate(approval) !== null)
    .slice(0, MAX_PLANS)
    .map((approval) => `${approval.planId}:${approval.etag}`)
    .join(',')

  useEffect(() => {
    if (!key) {
      setPlans(new Map())
      return
    }
    const controller = new AbortController()
    const targets = approvalsRef.current.filter((approval) => automationCandidate(approval) !== null).slice(0, MAX_PLANS)
    void Promise.all(targets.map(async (approval) => {
      try {
        const plan = await confirmPlan(api, approval, controller.signal)
        return plan ? ([approval.planId, plan] as const) : null
      } catch {
        return null
      }
    })).then((entries) => {
      if (!controller.signal.aborted) setPlans(new Map(entries.filter((entry) => entry !== null)))
    })
    return () => controller.abort()
  }, [api, key])

  return plans
}

export type AutomationPlanState = { busy: boolean; message: string | null }

const IDLE: AutomationPlanState = { busy: false, message: null }

function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ProductApiError) || error.status === 0 || error.status >= 500 || error.status === 429
}

function stale(error: unknown): boolean {
  return error instanceof ProductApiError
    && (error.status === 412 || error.code === 'precondition_failed' || error.code === 'automation_stale_input')
}

/** Approve, decline, undo the effect, or propose an expired plan again; `onChanged` re-reads the queue. */
export function useAutomationPlanActions(onChanged: () => void, api: AutomationApi = automationApi) {
  const { success } = useToast()
  const [states, setStates] = useState<Record<string, AutomationPlanState>>({})
  const set = useCallback((planId: string, state: AutomationPlanState) => {
    setStates((current) => ({ ...current, [planId]: state }))
  }, [])

  const run = useCallback(async (planId: string, action: () => Promise<string>, fallback: string) => {
    set(planId, { busy: true, message: null })
    try {
      success(await action())
      set(planId, IDLE)
    } catch (error) {
      set(planId, {
        busy: false,
        message: stale(error)
          ? 'This changed since you opened it. Review the latest version, then decide again.'
          : outcomeUnknown(error)
            ? 'This may not have been recorded. Try again to confirm it.'
            : error instanceof ProductApiError && error.message ? error.message : fallback,
      })
    } finally {
      onChanged()
    }
  }, [onChanged, set, success])

  const decide = useCallback((approval: WriteApprovalView, plan: AutomationPlan, decision: 'approve' | 'reject') => {
    const digest = plan.job.proposalDigest
    if (!digest) return
    void run(approval.planId, async () => {
      await api.decideJob(plan.job.id, {
        decision,
        proposalDigest: digest,
        reason: decision === 'approve' ? 'Owner approved the automation proposal.' : 'Owner declined the automation proposal.',
      }, plan.job.revision)
      return decision === 'approve' ? 'Approved. The change is being applied.' : 'Declined. Nothing was changed.'
    }, 'Could not record your decision.')
  }, [api, run])

  const undo = useCallback((approval: WriteApprovalView, plan: AutomationPlan) => {
    const { run: owner, effect } = plan
    if (!owner || !effect) return
    void run(approval.planId, async () => {
      await api.undoRunEffect(owner.id, {
        reason: 'Owner undid one automation change from Approvals.',
        expectedEffectDigest: effect.effectDigest,
        effectReceiptId: effect.id,
      }, owner.revision)
      return 'Undone.'
    }, 'Could not undo this change.')
  }, [api, run])

  const proposeAgain = useCallback((approval: WriteApprovalView, plan: AutomationPlan) => {
    void run(approval.planId, async () => {
      await api.retryJob(plan.job.id, plan.job.revision)
      return 'Proposed again. It waits here for your decision.'
    }, 'Could not propose this again.')
  }, [api, run])

  return {
    stateOf: (planId: string): AutomationPlanState => states[planId] ?? IDLE,
    decide,
    undo,
    proposeAgain,
  }
}
