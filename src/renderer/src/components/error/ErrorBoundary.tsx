import React, { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Bug, Copy, Check } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/useI18n'
import { DEFAULT_LOCALE } from '@/i18n/messages'
import { useSettingsStore } from '@/stores/useSettingsStore'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  componentName?: string
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  copied: boolean
}

function tBoundary(key: string, params?: Record<string, string | number | boolean>): string {
  const locale = useSettingsStore.getState().locale ?? DEFAULT_LOCALE
  return translate(locale, key, params)
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false
  }

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo })

    // Log to console in development
    console.error('ErrorBoundary caught error:', error, errorInfo)

    // Call optional error handler
    this.props.onError?.(error, errorInfo)
  }

  private handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      copied: false
    })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleCopyError = async (): Promise<void> => {
    const { error, errorInfo } = this.state
    const errorText = `
Error: ${error?.name || 'Unknown Error'}
Message: ${error?.message || 'No message'}

Stack Trace:
${error?.stack || 'No stack trace'}

Component Stack:
${errorInfo?.componentStack || 'No component stack'}
    `.trim()

    try {
      await navigator.clipboard.writeText(errorText)
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // Fallback to window.projectOps if available
      try {
        await window.projectOps.copyToClipboard(errorText)
        this.setState({ copied: true })
        setTimeout(() => this.setState({ copied: false }), 2000)
      } catch {
        console.error('Failed to copy error to clipboard')
      }
    }
  }

  public render(): ReactNode {
    const { hasError, error, errorInfo, copied } = this.state
    const { children, fallback, componentName } = this.props

    if (hasError) {
      // If custom fallback provided, use it
      if (fallback) {
        return fallback
      }

      // Default error UI
      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] p-6 bg-destructive/10 border border-destructive/20 rounded-lg m-4">
          <div className="flex items-center gap-2 text-destructive mb-4">
            <AlertTriangle className="h-6 w-6" />
            <h2 className="text-lg font-semibold">{tBoundary('errorBoundary.title')}</h2>
          </div>

          {componentName && (
            <p className="text-sm text-muted-foreground mb-2">
              {tBoundary('errorBoundary.componentPrefix')}{' '}
              <code className="bg-muted px-1 rounded">{componentName}</code>
            </p>
          )}

          <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
            {error?.message || tBoundary('errorBoundary.unexpected')}
          </p>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {tBoundary('errorBoundary.tryAgain')}
            </Button>

            <Button variant="outline" size="sm" onClick={this.handleReload}>
              {tBoundary('errorBoundary.reloadApp')}
            </Button>

            <Button variant="ghost" size="sm" onClick={this.handleCopyError}>
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {tBoundary('errorBoundary.copied')}
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" />
                  {tBoundary('errorBoundary.copyError')}
                </>
              )}
            </Button>
          </div>

          {/* Show detailed error in development */}
          {process.env.NODE_ENV === 'development' && errorInfo && (
            <details className="mt-4 w-full max-w-2xl">
              <summary className="cursor-pointer text-sm text-muted-foreground flex items-center gap-1">
                <Bug className="h-4 w-4" />
                {tBoundary('errorBoundary.developerDetails')}
              </summary>
              <pre className="mt-2 p-4 bg-muted rounded text-xs overflow-auto max-h-64">
                <code>
                  {error?.stack}
                  {'\n\nComponent Stack:'}
                  {errorInfo.componentStack}
                </code>
              </pre>
            </details>
          )}
        </div>
      )
    }

    return children
  }
}

export default ErrorBoundary
