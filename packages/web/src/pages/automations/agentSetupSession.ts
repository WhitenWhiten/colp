import type { AutomationAgentSetupResult } from '../../api/automationTypes'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'

// Layout remounts pages on navigation. This one-use handoff lives only in this
// tab's memory, expires with its grant, and is cleared on an account/session change.
const entries = new Map<string, { result: AutomationAgentSetupResult; timer: ReturnType<typeof setTimeout> }>()
let identity = privateSessionIdentity()
function forget(id: string) {
  const previous = entries.get(id)
  if (previous) clearTimeout(previous.timer)
  entries.delete(id)
}
subscribeSession(snapshot => {
  const next = privateSessionIdentity(snapshot)
  if (next !== identity) { for (const id of entries.keys()) forget(id); identity = next }
})

export const agentSetupSession = {
  forget,
  read: (id: string) => entries.get(id)?.result ?? null,
  remember(result: AutomationAgentSetupResult) {
    forget(result.rule.id)
    const expires = result.pairing ? Date.parse(result.pairing.expiresAt) - Date.now() : 60_000
    const timer = setTimeout(() => forget(result.rule.id), Math.min(2_147_000_000, Math.max(0, expires)))
    entries.set(result.rule.id, { result, timer })
  },
}
