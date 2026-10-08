import { Link } from 'react-router-dom'
import aboutMarkdown from '../../content/agent-public/about.md?raw'
import { SelfHostedAbout } from '../components/SelfHostedAbout'
import { isSelfHostedEdition, isSelfHostedPathEnabled } from '../lib/edition'
import { TrustDocument } from './TrustDocument'

export function About() {
  if (isSelfHostedEdition()) return <SelfHostedAbout />
  return (
    <TrustDocument
      markdown={aboutMarkdown}
      eyebrow="Product"
      documentTitle="About"
      actions={
        <>
          {isSelfHostedPathEnabled('/explore') && (
            <Link to="/explore" className="btn btn-primary btn-lg">
              Explore public paths
            </Link>
          )}
          <Link to="/extension" className="btn btn-secondary btn-lg">
            Browser extension
          </Link>
        </>
      }
    />
  )
}
