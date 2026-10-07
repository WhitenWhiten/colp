import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkLoadError } from '../lib/lazyWithRetry'
import { EmptyState } from './EmptyState'

type Props = {
  children: ReactNode
  resetKey: string
}

type State = {
  hasError: boolean
  chunkError: boolean
}

/** Catches render errors for the active route; resets when `resetKey` (pathname) changes. */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, chunkError: false }

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, chunkError: isChunkLoadError(error) }
  }

  /* Telemetry is reported once for every boundary by createRoot's
     onCaughtError (main.tsx). */
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[known:route-error]', error, info.componentStack ?? '')
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false, chunkError: false })
    }
  }

  private retry = () => {
    this.setState({ hasError: false, chunkError: false })
  }

  render() {
    if (this.state.chunkError) {
      /* React caches the rejected import, so "Try again" would re-throw;
         only a reload fetches the chunk again (R15-19). */
      return (
        <EmptyState
          role="alert"
          icon="alert"
          title="Couldn't load this page."
          description="Check your connection, then reload the page."
          action={
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          }
        />
      )
    }
    if (this.state.hasError) {
      return (
        <EmptyState
          role="alert"
          icon="alert"
          title="Something went wrong loading this page."
          description="Unsaved edits on this page may be gone. Try again to stay here, or return to the landing page."
          action={
            <>
              <button type="button" className="btn btn-primary" onClick={this.retry}>
                Try again
              </button>
              <a className="btn btn-secondary" href="/">
                Back to landing
              </a>
            </>
          }
        />
      )
    }
    return this.props.children
  }
}
