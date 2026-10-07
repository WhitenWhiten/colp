import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { isLive, isProductApiError, productClient } from '../api'
import { useAuth } from '../auth/AuthContext'
import { loginPath } from '../lib/chrome'
import { useToast } from './AppToast'
import { Modal } from './Modal'
import type { GovernanceReportInput } from '@known/product-v1-client'

const CATEGORIES: GovernanceReportInput['category'][] = [
  'spam', 'harassment', 'illegal_content', 'privacy', 'other',
]

/* The mailbox /contact publishes. R15-11 (D: help@ until T-04 names a
   dedicated abuse channel). */
const REPORT_EMAIL = 'help@know-n.com'

type Props = {
  target: GovernanceReportInput['target']
  label: string
  onClose: () => void
}

function reportMailto(title: string): string {
  const body = `Page: ${window.location.href}\n\nWhat is wrong:\n`
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

export function ReportContentDialog({ target, label, onClose }: Props) {
  const { isLoggedIn } = useAuth()
  const { success } = useToast()
  const enabled = isLive('contentGovernance')
  const [category, setCategory] = useState<GovernanceReportInput['category']>('spam')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const title = `Report ${label}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!enabled || !isLoggedIn || busy) return
    setBusy(true)
    setSubmitError(null)
    try {
      await productClient.submitModerationReport({
        target,
        category,
        description,
      }, { intentId: productClient.mutationIntentKey('moderation-report', productClient.newCommandId()), maxRetries: 0 })
      success('Report submitted.')
      onClose()
    } catch (err) {
      setSubmitError(isProductApiError(err) ? err.recoveryHint : 'The report could not be submitted')
    } finally {
      setBusy(false)
    }
  }

  /* R15-11: a report path for everyone. Guests (often the people a doxxing
     or infringement is about) and deployments without in-app reporting get
     sign-in and an email with the page address prefilled. */
  if (!enabled || !isLoggedIn) {
    return (
      <Modal
        open
        onClose={onClose}
        label={title}
        title={title}
        size="sm"
        overlayProps={{ 'data-testid': 'report-content-dialog' }}
      >
        <p className="meta">
          {enabled
            ? 'Sign in to send a report through Know-N, or email us. '
            : 'Email us to report this. '}
          The email includes this page’s address; add what is wrong.
        </p>
        <div className="row">
          {enabled ? (
            <Link
              className="btn btn-primary"
              to={loginPath(window.location.pathname, window.location.search)}
              data-testid="report-sign-in"
            >
              Sign in to report
            </Link>
          ) : null}
          <a className="btn btn-secondary" href={reportMailto(title)} data-testid="report-email">
            Email {REPORT_EMAIL}
          </a>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      label={title}
      title={title}
      size="sm"
      overlayProps={{ 'data-testid': 'report-content-dialog' }}
    >
      <form className="edit-form" onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="report-category">Category</label>
          <select
            id="report-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as GovernanceReportInput['category'])}
            data-testid="report-category"
          >
            {CATEGORIES.map((item) => (
              <option key={item} value={item}>{item.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="report-description">Description</label>
          <textarea
            id="report-description"
            required
            minLength={1}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="report-description"
          />
        </div>
        {submitError ? <p className="field-error" role="alert">{submitError}</p> : null}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>Submit report</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

/** The "Report" control plus its dialog, for any governance target. Shown to
    every visitor: the dialog itself picks the in-app form or the guest path. */
export function ReportButton({ target, label, testId, className = 'btn btn-ghost btn-sm' }: {
  target: GovernanceReportInput['target']
  label: string
  testId: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} data-testid={testId} onClick={() => setOpen(true)}>
        Report
      </button>
      {open ? <ReportContentDialog target={target} label={label} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
