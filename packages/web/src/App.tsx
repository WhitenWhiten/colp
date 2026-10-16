import { BrowserRouter, Navigate, Routes, Route, useLocation, useParams } from 'react-router-dom'
import { isLive } from './api/featureFlags'
import { Layout } from './components/Layout'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { settingsRedirectTo } from './lib/useSettingsDialog'
import { Landing } from './pages/Landing'
const About = lazyWithRetry('About', async () => (await import('./components/SelfHostedAbout')).SelfHostedAbout)
const Agents = lazyWithRetry('Agents', async () => (await import('./pages/Agents')).Agents)
const Automations = lazyWithRetry('Automations', async () => (await import('./pages/Automations')).Automations)
const Collection = lazyWithRetry('Collection', async () => (await import('./pages/Collection')).Collection)
const Library = lazyWithRetry('Library', async () => (await import('./pages/Library')).Library)
const CollectionEditor = lazyWithRetry('CollectionEditor', async () => (await import('./pages/CollectionEditor')).CollectionEditor)
const Login = lazyWithRetry('Login', async () => (await import('./pages/SelfHostedLogin')).SelfHostedLogin)
const Register = lazyWithRetry('Register', async () => (await import('./pages/SelfHostedRegister')).SelfHostedRegister)
const AuthRecovery = lazyWithRetry('AuthRecovery', async () => (await import('./pages/AuthRecovery')).AuthRecovery)
const Graph = lazyWithRetry('Graph', async () => (await import('./pages/Graph')).Graph)
const Sync = lazyWithRetry('Sync', async () => (await import('./pages/Sync')).Sync)
const Search = lazyWithRetry('Search', async () => (await import('./pages/Search')).Search)
const Extension = lazyWithRetry('Extension', async () => (await import('./pages/Extension')).Extension)
const ResourceDetail = lazyWithRetry('ResourceDetail', async () => (await import('./pages/ResourceDetail')).ResourceDetail)
const WriteApprovals = lazyWithRetry('WriteApprovals', async () => (await import('./pages/WriteApprovals')).WriteApprovals)
const Consent = lazyWithRetry('Consent', async () => (await import('./pages/Consent')).Consent)
const Import = lazyWithRetry('Import', async () => (await import('./pages/SelfHostedImport')).SelfHostedImport)
const CollectionHistory = lazyWithRetry('CollectionHistory', async () => (await import('./pages/CollectionHistory')).CollectionHistory)
const LibraryHealth = lazyWithRetry('LibraryHealth', async () => (await import('./pages/LibraryHealth')).LibraryHealth)
const Collaborators = lazyWithRetry('Collaborators', async () => (await import('./pages/Collaborators')).Collaborators)
const NotFound = lazyWithRetry('NotFound', async () => (await import('./pages/NotFound')).NotFound)


/** Permanent compatibility stub for in-flight mail and OAuth callback URLs. */
export function SettingsRedirect() {
  const { hash } = useLocation()
  return <Navigate to={settingsRedirectTo(hash)} replace />
}

/** Collaborators waits for multi-user; an old link opens the collection. */
function CollaboratorsRoute() {
  const { id = '' } = useParams()
  if (!isLive('collaborators')) return <Navigate to={`/library/${encodeURIComponent(id)}`} replace />
  return <Collaborators />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          <Route path="search" element={<Search />} />
          <Route path="c/:slug" element={<Collection />} />
          <Route path="r/:id" element={<ResourceDetail />} />
          <Route path="library/health" element={<LibraryHealth />} />
          <Route path="library/:id/edit" element={<CollectionEditor />} />
          <Route path="library/:id/history" element={<CollectionHistory />} />
          <Route path="library/:id/collaborators" element={<CollaboratorsRoute />} />
          <Route path="library/:id?" element={<Library />} />
          <Route path="dashboard" element={<Navigate to="/library" replace />} />
          <Route path="login" element={<Login />} />
          <Route path="consent" element={<Consent />} />
          <Route path="register" element={<Register />} />
          <Route path="auth/recovery" element={<AuthRecovery />} />
          <Route path="graph/:slug" element={<Graph />} />
          <Route path="settings" element={<SettingsRedirect />} />
          <Route path="extension" element={<Extension />} />
          <Route path="sync" element={<Sync />} />
          <Route path="import" element={<Import />} />
          <Route path="approvals" element={<WriteApprovals />} />
          <Route path="approvals/:planId" element={<WriteApprovals />} />
          <Route path="about" element={<About />} />
          <Route path="mcp" element={<Navigate to="/agents" replace />} />
          <Route path="agents" element={<Agents />} />
          <Route path="automations/*" element={<Automations />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
