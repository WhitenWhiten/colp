import { Link } from 'react-router-dom'
import privacyMarkdown from '../../content/agent-public/privacy.md?raw'
import { TrustDocument } from './TrustDocument'

export function Privacy() {
  return (
    <TrustDocument
      markdown={privacyMarkdown}
      documentTitle="Privacy"
      actions={
        <>
          <Link to="/about" className="btn btn-primary btn-lg">
            About Know-N
          </Link>
          <Link to="/contact" className="btn btn-secondary btn-lg">
            Contact
          </Link>
        </>
      }
    />
  )
}
