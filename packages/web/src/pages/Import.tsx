import { Link } from 'react-router-dom'
import { Breadcrumb } from '../components/Breadcrumb'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { Stepper } from '../components/Stepper'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/import.css'

export function Import() {
  return (
    <PageShell variant="grid">
      <div className="import-handoff" data-extension-handoff>
        <PageHead
          variant="workbench"
          breadcrumb={
            <Breadcrumb items={[{ label: 'Library', to: '/library' }, { label: 'Import' }]} />
          }
          title="Import bookmarks"
          documentTitle="Import"
          lede="Bookmarks are imported by the Know-N browser extension, which can read your browser's bookmarks and files."
        />
        <Stepper
          className="import-handoff-steps"
          label="Import steps"
          items={[
            { body: "Click the Know-N icon in your browser's toolbar, then the Settings gear." },
            { body: "Sign in if you haven't, then open Sync › Import." },
            { body: "Choose HTML file to import a bookmark file you exported, or This browser's bookmarks to copy the folders you already have." },
          ]}
        />
        <div className="import-handoff-actions">
          <Link className="btn btn-primary" to="/extension">Open extension</Link>
          <Link className="btn btn-secondary" to="/sync">View sync status</Link>
        </div>
        <p className="meta import-handoff-note">The website cannot read extension storage, credentials, or browser bookmarks.</p>
      </div>
    </PageShell>
  )
}
