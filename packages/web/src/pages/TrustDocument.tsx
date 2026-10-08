import type { ReactNode } from 'react'
import { PageHead } from '../components/PageHead'
import { PageSection, PageShell } from '../components/PageShell'
import { splitAgentPublicMarkdown } from '../lib/agentPublicMarkdown'

type TrustDocumentProps = {
  markdown: string
  eyebrow?: string
  documentTitle: string
  actions?: ReactNode
}

export function TrustDocument({ markdown, eyebrow, documentTitle, actions }: TrustDocumentProps) {
  const { title, lede, bodyHtml } = splitAgentPublicMarkdown(markdown)

  /* R9-14: narrow (46rem) — these are prose/legal/reference documents; the
     default 90rem shell gave ~150-170 char lines. The MCP page's fenced curl
     blocks still fit: pre wraps (pre-wrap + max-width 100%). */
  return (
    <PageShell variant="narrow" sections>
      <PageSection>
        <PageHead
          className="page-head--editorial"
          eyebrow={eyebrow}
          title={title}
          documentTitle={documentTitle}
          lede={lede}
        />
        {actions != null ? <div className="cta-row">{actions}</div> : null}
      </PageSection>
      {bodyHtml ? (
        <PageSection
          className="panel panel-pad trust-doc"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      ) : null}
    </PageShell>
  )
}
