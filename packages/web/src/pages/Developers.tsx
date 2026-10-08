import { Link } from 'react-router-dom'
import developersMarkdown from '../../content/agent-public/developers.md?raw'
import { TrustDocument } from './TrustDocument'

export function Developers() {
  return (
    <TrustDocument
      markdown={developersMarkdown}
      eyebrow="Agents"
      documentTitle="Developers"
      actions={
        <>
          <Link to="/embed-guide" className="btn btn-secondary btn-lg">Embed styling guide</Link>
          <Link to="/mcp" className="btn btn-primary btn-lg">
            MCP connection
          </Link>
          <a href="/.well-known/collection-protocol" className="btn btn-secondary btn-lg">
            Collection protocol
          </a>
        </>
      }
    />
  )
}
