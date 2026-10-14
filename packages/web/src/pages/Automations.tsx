import { Navigate, Route, Routes } from 'react-router-dom'
import { AutomationsHome } from './automations/AutomationsHome'
import { RuleEditor } from './automations/RuleEditor'
import { AutomationDepsProvider, type AutomationDeps } from './automations/shared'
// Route-owned stylesheet, shared with the bookmark page's Automation section.
import '../styles/automations.css'

/** `/automations/*`: the rule list, the rule editor and, later, runs. */
export function Automations({ deps }: { deps?: AutomationDeps } = {}) {
  const routes = (
    <Routes>
      <Route index element={<AutomationsHome />} />
      <Route path="new" element={<RuleEditor />} />
      <Route path="rules/:ruleId/edit" element={<RuleEditor />} />
      <Route path="*" element={<Navigate to="/automations" replace />} />
    </Routes>
  )
  return deps ? <AutomationDepsProvider value={deps}>{routes}</AutomationDepsProvider> : routes
}
