import contactMarkdown from '../../content/agent-public/contact.md?raw'
import { TrustDocument } from './TrustDocument'

const HELP_MAILTO = 'mailto:help@know-n.com'

export function Contact() {
  return (
    <TrustDocument
      markdown={contactMarkdown}
      documentTitle="Contact"
      actions={
        <a className="btn btn-primary btn-lg" href={HELP_MAILTO}>
          Email help@know-n.com
        </a>
      }
    />
  )
}
