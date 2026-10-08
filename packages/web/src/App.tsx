import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DEMO_ROUTES_ENABLED } from './lib/demoRoutes'
import { isSelfHostedEdition } from './lib/edition'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { settingsRedirectTo } from './lib/useSettingsDialog'
import { Landing } from './pages/Landing'
/* R15-27: trust pages are split like every other route; their markdown was
   ~19 KB gzip of the entry chunk. */
const About = lazyWithRetry('About', async () => (await import('./pages/About')).About)
const Contact = lazyWithRetry('Contact', async () => (await import('./pages/Contact')).Contact)
const Developers = lazyWithRetry('Developers', async () => (await import('./pages/Developers')).Developers)
const EmbedGuide = lazyWithRetry('EmbedGuide', async () => (await import('./pages/EmbedGuide')).EmbedGuide)
const Agents = lazyWithRetry('Agents', async () => (await import('./pages/Agents')).Agents)
const Privacy = lazyWithRetry('Privacy', async () => (await import('./pages/Privacy')).Privacy)
const Explore = lazyWithRetry('Explore', async () => (await import('./pages/Explore')).Explore)
const Collection = lazyWithRetry('Collection', async () => (await import('./pages/Collection')).Collection)
const Profile = lazyWithRetry('Profile', async () => (await import('./pages/Profile')).Profile)
const Library = lazyWithRetry('Library', async () => (await import('./pages/Library')).Library)
const CollectionEditor = lazyWithRetry('CollectionEditor', async () => (await import('./pages/CollectionEditor')).CollectionEditor)
const CreateCollection = lazyWithRetry('CreateCollection', async () => (await import('./pages/CreateCollection')).CreateCollection)
const Login = lazyWithRetry('Login', async () => (await import('./pages/Login')).Login)
const Register = lazyWithRetry('Register', async () => (await import('./pages/Register')).Register)
const PasswordReset = lazyWithRetry('PasswordReset', async () => (await import('./pages/PasswordReset')).PasswordReset)
const EmailVerification = lazyWithRetry('EmailVerification', async () => (await import('./pages/EmailVerification')).EmailVerification)
const AuthRecovery = lazyWithRetry('AuthRecovery', async () => (await import('./pages/AuthRecovery')).AuthRecovery)
const Onboarding = lazyWithRetry('Onboarding', async () => (await import('./pages/Onboarding')).Onboarding)
const Graph = lazyWithRetry('Graph', async () => (await import('./pages/Graph')).Graph)
const Sync = lazyWithRetry('Sync', async () => (await import('./pages/Sync')).Sync)
const ClassificationBatch = lazyWithRetry('ClassificationBatch', async () => (await import('./pages/ClassificationBatch')).ClassificationBatch)
const Classify = lazyWithRetry('Classify', async () => (await import('./pages/Classify')).Classify)
const Search = lazyWithRetry('Search', async () => (await import('./pages/Search')).Search)
const Feed = lazyWithRetry('Feed', async () => (await import('./pages/Feed')).Feed)
const Creator = lazyWithRetry('Creator', async () => (await import('./pages/Creator')).Creator)
const Extension = lazyWithRetry('Extension', async () => (await import('./pages/Extension')).Extension)
const ResourceDetail = lazyWithRetry('ResourceDetail', async () => (await import('./pages/ResourceDetail')).ResourceDetail)
const CommunityCommentRedirect = lazyWithRetry('CommunityCommentRedirect', async () => (await import('./pages/CommunityCommentRedirect')).CommunityCommentRedirect)
const AiOrganize = lazyWithRetry('AiOrganize', async () => (await import('./pages/AiOrganize')).AiOrganize)
const Share = lazyWithRetry('Share', async () => (await import('./pages/Share')).Share)
const PathReader = lazyWithRetry('PathReader', async () => (await import('./pages/PathReader')).PathReader)
const Notifications = lazyWithRetry('Notifications', async () => (await import('./pages/Notifications')).Notifications)
const Credits = lazyWithRetry('Credits', async () => (await import('./pages/Credits')).Credits)
const WriteApprovals = lazyWithRetry('WriteApprovals', async () => (await import('./pages/WriteApprovals')).WriteApprovals)
const Consent = lazyWithRetry('Consent', async () => (await import('./pages/Consent')).Consent)
const Import = lazyWithRetry('Import', async () => (await import('./pages/Import')).Import)
const Today = lazyWithRetry('Today', async () => (await import('./pages/Today')).Today)
const CollectionHistory = lazyWithRetry('CollectionHistory', async () => (await import('./pages/CollectionHistory')).CollectionHistory)
const Reports = lazyWithRetry('Reports', async () => (await import('./pages/Reports')).Reports)
const MemberDigestReader = lazyWithRetry('MemberDigestReader', async () => (await import('./pages/MemberDigestReader')).MemberDigestReader)
const ReportSeries = lazyWithRetry('ReportSeries', async () => (await import('./pages/ReportSeries')).ReportSeries)
const ReportIssue = lazyWithRetry('ReportIssue', async () => (await import('./pages/ReportIssue')).ReportIssue)
const MyDigests = lazyWithRetry('MyDigests', async () => (await import('./pages/MyDigests')).MyDigests)
const DigestManage = lazyWithRetry('DigestManage', async () => (await import('./pages/DigestManage')).DigestManage)
const ReaderRoute = lazyWithRetry('ReaderRoute', async () => (await import('./pages/ReaderRoute')).ReaderRoute)
const LibraryHealth = lazyWithRetry('LibraryHealth', async () => (await import('./pages/LibraryHealth')).LibraryHealth)
const Collaborators = lazyWithRetry('Collaborators', async () => (await import('./pages/Collaborators')).Collaborators)
const DataExport = lazyWithRetry('DataExport', async () => (await import('./pages/DataExport')).DataExport)
const NotFound = lazyWithRetry('NotFound', async () => (await import('./pages/NotFound')).NotFound)
const ModerationReports = lazyWithRetry('ModerationReports', async () => (await import('./pages/ModerationReports')).ModerationReports)
const ModerationAppeals = lazyWithRetry('ModerationAppeals', async () => (await import('./pages/ModerationAppeals')).ModerationAppeals)
const ModerationCases = lazyWithRetry('admin/ModerationCases', async () => (await import('./pages/admin/ModerationCases')).ModerationCases)
const ModerationCaseDetail = lazyWithRetry('admin/ModerationCaseDetail', async () => (await import('./pages/admin/ModerationCaseDetail')).ModerationCaseDetail)
const AdminModerationAppeals = lazyWithRetry('admin/ModerationAppeals', async () => (await import('./pages/admin/ModerationAppeals')).ModerationAppeals)

/* Demo and QA sandboxes. Created only when DEMO_ROUTES_ENABLED, so a
   production build folds these to NotFound and drops their chunks (R15-09). */
const DemoHub = DEMO_ROUTES_ENABLED ? lazyWithRetry('DemoHub', async () => (await import('./pages/DemoHub')).DemoHub) : NotFound
const ExtensionPopup = DEMO_ROUTES_ENABLED ? lazyWithRetry('ExtensionPopup', async () => (await import('./pages/ExtensionPopup')).ExtensionPopup) : NotFound
const LegacyLibrary = DEMO_ROUTES_ENABLED ? lazyWithRetry('LegacyLibrary', async () => (await import('./pages/LegacyLibrary')).LegacyLibrary) : NotFound
const LibraryEdit = DEMO_ROUTES_ENABLED ? lazyWithRetry('LibraryEdit', async () => (await import('./pages/LibraryEdit')).LibraryEdit) : NotFound
const Dashboard = DEMO_ROUTES_ENABLED ? lazyWithRetry('Dashboard', async () => (await import('./pages/Dashboard')).Dashboard) : NotFound
const AiChat = DEMO_ROUTES_ENABLED ? lazyWithRetry('AiChat', async () => (await import('./pages/AiChat')).AiChat) : NotFound

const selfHostedEdition = isSelfHostedEdition()

/** Permanent compatibility stub for in-flight mail and OAuth callback URLs. */
export function SettingsRedirect() {
  const { hash } = useLocation()
  return <Navigate to={settingsRedirectTo(hash)} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Landing />} />
          {!selfHostedEdition && <Route path="today" element={<Today />} />}
          {!selfHostedEdition && <Route path="updates" element={<Navigate to="/notifications?filter=collection" replace />} />}
          {!selfHostedEdition && <Route path="explore" element={<Explore />} />}
          <Route path="search" element={<Search />} />
          {!selfHostedEdition && <Route path="feed" element={<Feed />} />}
          <Route path="c/:slug" element={<Collection />} />
          {/* Digest paths mirror the backend public shell (/reports*): the
              shell serves crawlers and no-JS readers, the SPA boots on top. */}
          {!selfHostedEdition && <Route path="reports" element={<Reports />} />}
          {!selfHostedEdition && <Route path="reports/:slug" element={<ReportSeries />} />}
          {!selfHostedEdition && <Route path="reports/:slug/issues/:editionId" element={<ReportIssue />} />}
          {!selfHostedEdition && <Route path="path/:slug" element={<PathReader />} />}
          {!selfHostedEdition && <Route path="share" element={<Share />} />}
          {!selfHostedEdition && <Route path="share/:slug" element={<Share />} />}
          {!selfHostedEdition && <Route path="u/:handle" element={<Profile />} />}
          {!selfHostedEdition && <Route path="profile/:handle" element={<Profile />} />}
          <Route path="r/:id" element={<ResourceDetail />} />
          {/* CS-03: durable comment deep link resolves to the canonical
              target page thread anchor. */}
          {!selfHostedEdition && <Route path="community/comments/:commentId" element={<CommunityCommentRedirect />} />}
          <Route path="read/:resourceId" element={<ReaderRoute />} />
          <Route path="library/new" element={<CreateCollection />} />
          <Route path="library/health" element={<LibraryHealth />} />
          {!selfHostedEdition && <Route path="library/digests" element={<MyDigests />} />}
          {!selfHostedEdition && <Route path="library/digests/:id" element={<DigestManage />} />}
          {!selfHostedEdition && <Route path="library/digests/:id/read" element={<MemberDigestReader />} />}
          {!selfHostedEdition && <Route path="library/digests/:id/issues/:editionId/read" element={<MemberDigestReader />} />}
          <Route path="library/:id/edit" element={<CollectionEditor />} />
          <Route path="library/:id/history" element={<CollectionHistory />} />
          <Route path="library/:id/collaborators" element={<Collaborators />} />
          {!selfHostedEdition && <Route path="library/following/:slug" element={<Library />} />}
          <Route path="library/:id?" element={<Library />} />
          {!selfHostedEdition && <Route path="dashboard" element={<Navigate to="/today" replace />} />}
          {selfHostedEdition && <Route path="dashboard" element={<Navigate to="/library" replace />} />}
          <Route path="login" element={<Login />} />
          <Route path="consent" element={<Consent />} />
          <Route path="register" element={<Register />} />
          <Route path="reset-password" element={<PasswordReset />} />
          <Route path="verify-email" element={<EmailVerification />} />
          <Route path="auth/recovery" element={<AuthRecovery />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="graph/:slug" element={<Graph />} />
          {!selfHostedEdition && <Route path="creator" element={<Creator />} />}
          {!selfHostedEdition && <Route path="export" element={<DataExport />} />}
          <Route path="settings" element={<SettingsRedirect />} />
          {!selfHostedEdition && <Route path="settings/export" element={<Navigate to="/export" replace />} />}
          <Route path="extension" element={<Extension />} />
          <Route path="sync" element={<Sync />} />
          {!selfHostedEdition && <Route path="classify" element={<Classify />} />}
          {!selfHostedEdition && <Route path="classify/batch" element={<ClassificationBatch />} />}
          <Route path="import" element={<Import />} />
          {!selfHostedEdition && <Route path="notifications" element={<Notifications />} />}
          {!selfHostedEdition && <Route path="credits" element={<Credits />} />}
          {!selfHostedEdition && <Route path="moderation/reports" element={<ModerationReports />} />}
          {!selfHostedEdition && <Route path="moderation/appeals" element={<ModerationAppeals />} />}
          {!selfHostedEdition && <Route path="admin/moderation/cases" element={<ModerationCases />} />}
          {!selfHostedEdition && <Route path="admin/moderation/cases/:caseId" element={<ModerationCaseDetail />} />}
          {!selfHostedEdition && <Route path="admin/moderation/appeals" element={<AdminModerationAppeals />} />}
          <Route path="approvals" element={<WriteApprovals />} />
          <Route path="approvals/:planId" element={<WriteApprovals />} />
          {!selfHostedEdition && <Route path="ai/organize" element={<AiOrganize />} />}
          <Route path="about" element={<About />} />
          {!selfHostedEdition && <Route path="contact" element={<Contact />} />}
          {!selfHostedEdition && <Route path="privacy" element={<Privacy />} />}
          {selfHostedEdition ? <Route path="mcp" element={<Navigate to="/agents" replace />} /> : <Route path="mcp" element={<Agents />} />}
          {selfHostedEdition && <Route path="agents" element={<Agents />} />}
          {!selfHostedEdition && <Route path="developers" element={<Developers />} />}
          {!selfHostedEdition && <Route path="embed-guide" element={<EmbedGuide />} />}
          <Route path="*" element={<NotFound />} />
        </Route>
        {/* Demo tree — mock-only sandboxes preserved for comparison, mounted
            only in development or when VITE_DEMO_ROUTES=true (R15-09); in
            production these URLs fall to the product 404. Pages wired to the
            live Product API are not mirrored here (DemoHub at /demos is the
            product map for those); anything else under /demo falls through
            to the demo 404 instead of rendering an empty Outlet. */}
        {DEMO_ROUTES_ENABLED && !selfHostedEdition && (
          <Route path="demo" element={<Layout />}>
            <Route index element={<DemoHub />} />
            <Route path="updates" element={<Navigate to="/notifications?filter=collection" replace />} />
            {/* Demo seed-bookmark stack — not the product /library desk */}
            <Route path="library" element={<LegacyLibrary />} />
            <Route path="library/:id/edit" element={<LibraryEdit />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="ai/chat" element={<AiChat />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        )}
        {DEMO_ROUTES_ENABLED && !selfHostedEdition && (
          <Route element={<Layout />}>
            <Route path="demos" element={<DemoHub />} />
            <Route path="extension/popup" element={<ExtensionPopup />} />
          </Route>
        )}
      </Routes>
    </BrowserRouter>
  )
}
