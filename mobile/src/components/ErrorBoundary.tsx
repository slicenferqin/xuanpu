/**
 * ErrorBoundary: classic React error boundary so a single throwing component
 * (a malformed tool input, a stray null deref, etc.) doesn't unmount the
 * entire SessionDetail tree and leave the user staring at a black screen.
 *
 * Renders a small inline error chip and lets the user reload the route.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Override the fallback UI; default is a red chip with the message. */
  fallback?: (err: Error, reset: () => void) => ReactNode
}

interface State {
  err: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught:', err, info)
  }

  reset = (): void => {
    this.setState({ err: null })
  }

  render(): ReactNode {
    if (!this.state.err) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.state.err, this.reset)
    return (
      <div className="m-3 p-3 rounded-lg bg-red-950/40 border border-red-900/60 text-sm">
        <p className="font-medium text-red-300">页面出错了</p>
        <p className="text-xs text-red-400/80 mt-1 break-words">
          {this.state.err.message || String(this.state.err)}
        </p>
        <button
          onClick={this.reset}
          className="mt-2 px-3 py-1.5 rounded-md bg-red-900/40 active:bg-red-800/60 text-xs text-red-100"
        >
          重试渲染
        </button>
      </div>
    )
  }
}
