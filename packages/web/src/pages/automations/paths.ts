/** Where automation pages live; ids are opaque and always encoded. */

export function rulePath(id: string): string {
  return `/automations/rules/${encodeURIComponent(id)}`
}

export function ruleEditPath(id: string): string {
  return `${rulePath(id)}/edit`
}

export function runPath(id: string): string {
  return `/automations/runs/${encodeURIComponent(id)}`
}
