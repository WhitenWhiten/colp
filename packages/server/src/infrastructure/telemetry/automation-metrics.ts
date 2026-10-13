import type { Rule } from '@know-n/colp/automation';

export interface AutomationObservation {
  period_start: Date; period_end: Date; budget_day: string; admitted: number;
  ready: number; succeeded: number; held: number; pending: number; leased: number;
  committing: number; blocked: number; budget_blocked: number; approval: number; uncertain: number;
  calls: number; unknown: number; reported: string; daily_limit: number; reserved: number;
}

/** Allowlisted scalar projection; never spread private query rows into public metrics. */
export function automationUsageView(row: AutomationObservation): NonNullable<Rule['usage']> {
  return {
    periodStart: row.period_start.toISOString(),periodEnd: row.period_end.toISOString(),admittedRuns: row.admitted,
    readyJobs: row.ready,succeededJobs: row.succeeded,heldJobs: row.held,pendingJobs: row.pending,leasedJobs: row.leased,
    committingJobs: row.committing,policyBlockedJobs: row.blocked,budgetBlockedJobs: row.budget_blocked,
    awaitingApprovalJobs: row.approval,uncertainJobs: row.uncertain,optionalCalls: row.calls,unknownCostCalls: row.unknown,
    reportedCostMicros: row.reported,externalCosts: row.unknown ? 'unknownDisclosed' : row.calls ? 'known' : 'notApplicable',
    costDisplay: row.unknown ? 'External cost is unknown for one or more calls; reported amounts are unverified observations.'
      : row.calls ? 'All calls have worker-reported cost observations; provider billing is unverified.' : 'No optional external calls observed.',
    budgetDay: row.budget_day,dailyRunLimit: row.daily_limit,reservedRuns: row.reserved,remainingRuns: Math.max(0,row.daily_limit-row.reserved),
    deliveryCapability: 'unavailable',acceptedDeliveries: null,
  };
}
