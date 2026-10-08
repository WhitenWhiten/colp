import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isSelfHostedEdition, productName } from '../lib/edition'

type Props = {
  children: ReactNode
}

type State = {
  hasError: boolean
}

/**
 * R15-19: last-resort boundary around the whole app (main.tsx). Its
 * fallback uses no providers, router or context, so it renders even when
 * AuthProvider or the Layout itself failed.
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[known:root-error]', error, info.componentStack ?? '')
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <main className="root-error" role="alert">
        {/* The self-hosted build ships no Know-N wordmark (self-hosted-dist.mjs). */}
        {isSelfHostedEdition()
          ? <p className="root-error-name">{productName()}</p>
          : <img src="/brand-wordmark.svg" alt="Know-N" width={438} height={128} />}
        <p>{productName()} ran into a problem and couldn&apos;t show this page.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </main>
    )
  }
}
