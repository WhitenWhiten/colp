import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  name: string
  children: ReactNode
}

type State = {
  hasError: boolean
}

/**
 * R15-19: wraps a piece of chrome (TopNav, Footer, BottomNav, the Settings
 * dialog). On a render error or failed chunk it renders nothing, so the
 * page under it keeps working.
 */
export class ChromeErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[known:chrome-error] ${this.props.name}`, error, info.componentStack ?? '')
  }

  render() {
    return this.state.hasError ? null : this.props.children
  }
}
