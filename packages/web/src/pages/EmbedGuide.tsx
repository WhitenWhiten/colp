import { Link } from 'react-router-dom'
import guideMarkdown from '../../content/agent-public/embed-guide.md?raw'
import { TrustDocument } from './TrustDocument'

export function EmbedGuide() {
  return <TrustDocument markdown={guideMarkdown} eyebrow="Agents" documentTitle="Embed styling guide" actions={
    <>
      <a href="/embed-guide.md" className="btn btn-primary btn-lg">Read as Markdown</a>
      <Link to="/developers" className="btn btn-secondary btn-lg">Developer discovery</Link>
    </>
  } />
}
