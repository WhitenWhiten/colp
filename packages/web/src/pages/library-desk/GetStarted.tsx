import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'

const DISMISSED_KEY = 'colp.getStarted.dismissed'
export function getStartedHidden(): boolean {
  try { return localStorage.getItem(DISMISSED_KEY) === '1' } catch { return false }
}
export function GetStarted({ onNewFolder }: { onNewFolder: () => void }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return <section className="get-started" aria-labelledby="get-started-title" data-testid="get-started">
    <div className="get-started-head">
      <div><p className="section-label">Get started</p><h2 id="get-started-title">Your bookmark library is ready</h2></div>
      <button type="button" className="get-started-dismiss" aria-label="Hide the setup checklist" onClick={() => {
        try { localStorage.setItem(DISMISSED_KEY, '1') } catch { /* This visit only. */ }
        setDismissed(true)
      }}><Icon name="cross" /></button>
    </div>
    <ol className="get-started-steps">
      <li className="get-started-step"><span className="get-started-mark" aria-hidden><Icon name="browser" /></span>
        <div className="get-started-text"><h3>Install the extension</h3><p>Sync this browser’s bookmarks with your library.</p></div>
        <Link to="/extension" className="btn btn-secondary btn-sm">Install the extension</Link></li>
      <li className="get-started-step"><span className="get-started-mark" aria-hidden><Icon name="folder" /></span>
        <div className="get-started-text"><h3>Make room for your bookmarks</h3><p>Create a folder in Bookmarks bar or Other bookmarks.</p></div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onNewFolder}>New folder</button></li>
    </ol>
  </section>
}
