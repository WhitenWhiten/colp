import { Fragment, useSyncExternalStore } from 'react'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AutomationsHome } from './automations/AutomationsHome'
import { Digests } from './automations/Digests'
import { RuleDetail } from './automations/RuleDetail'
import { RunDetail } from './automations/RunDetail'
import { RunOnce } from './automations/RunOnce'
import { RuleEditor } from './automations/RuleEditor'
import { AutomationDepsProvider, type AutomationDeps } from './automations/shared'
// Route-owned stylesheet, shared with the bookmark page's Automation section.
import '../styles/automations.css'

/** `/automations/*`: the rule list, a rule, its editor, running it once, one run, and what runs wrote. */
export function Automations({ deps }: { deps?: AutomationDeps } = {}) {
  const identity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const routes = (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route path="new" element={<RuleEditor />} />
      <Route path="digests" element={<Digests />} />
      <Route path="rules/:ruleId" element={<RuleDetail />} />
      <Route path="rules/:ruleId/edit" element={<RuleEditor />} />
      <Route path="rules/:ruleId/run-once" element={<RunOnce />} />
      <Route path="runs/:runId" element={<RunDetail />} />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
  return <Fragment key={identity}>{deps ? <AutomationDepsProvider value={deps}>{routes}</AutomationDepsProvider> : routes}</Fragment>
}
