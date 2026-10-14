import { Navigate, Route, Routes } from 'react-router-dom'
import { AutomationsHome } from './automations/AutomationsHome'
import { RuleDetail } from './automations/RuleDetail'
import { RunDetail } from './automations/RunDetail'
import { RuleEditor } from './automations/RuleEditor'
import { AutomationDepsProvider, type AutomationDeps } from './automations/shared'
// Route-owned stylesheet, shared with the bookmark page's Automation section.
import '../styles/automations.css'

/** `/automations/*`: the rule list, a rule, its editor, and one run. */
export function Automations({ deps }: { deps?: AutomationDeps } = {}) {
  const routes = (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route path="new" element={<RuleEditor />} />
      <Route path="rules/:ruleId" element={<RuleDetail />} />
      <Route path="rules/:ruleId/edit" element={<RuleEditor />} />
      <Route path="runs/:runId" element={<RunDetail />} />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
  return deps ? <AutomationDepsProvider value={deps}>{routes}</AutomationDepsProvider> : routes
}
