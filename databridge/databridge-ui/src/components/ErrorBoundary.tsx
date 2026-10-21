import React, { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.setState({
      error,
      errorInfo,
    })
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
  }

  handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="min-h-screen flex items-center justify-center p-6"
          style={{ background: 'var(--bg-primary)' }}
        >
          <div className="max-w-2xl w-full">
            <div
              className="card p-8 text-center"
              style={{
                border: '2px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.05)',
              }}
            >
              <div
                className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg,#ef4444,#dc2626)',
                  boxShadow: '0 8px 24px rgba(239,68,68,0.3)',
                }}
              >
                <AlertTriangle size={32} style={{ color: '#fff' }} />
              </div>

              <h1
                className="text-2xl font-bold mb-3"
                style={{
                  fontFamily: 'var(--font-heading)',
                  color: 'var(--text-primary)',
                }}
              >
                Something Went Wrong
              </h1>

              <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
                An unexpected error occurred. This has been logged and we'll look into it.
              </p>

              {this.state.error && (
                <div
                  className="p-4 rounded-lg mb-6 text-left"
                  style={{
                    background: 'rgba(0,0,0,0.2)',
                    border: '1px solid rgba(239,68,68,0.3)',
                  }}
                >
                  <p
                    className="text-xs font-mono mb-2"
                    style={{ color: '#f87171', fontWeight: 600 }}
                  >
                    Error Details:
                  </p>
                  <p
                    className="text-xs font-mono"
                    style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}
                  >
                    {this.state.error.toString()}
                  </p>
                  {this.state.errorInfo && (
                    <details className="mt-3">
                      <summary
                        className="text-xs cursor-pointer"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Stack Trace
                      </summary>
                      <pre
                        className="text-xs mt-2 overflow-auto max-h-40"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {this.state.errorInfo.componentStack}
                      </pre>
                    </details>
                  )}
                </div>
              )}

              <div className="flex gap-3 justify-center">
                <button
                  onClick={this.handleReset}
                  className="btn-secondary flex items-center gap-2"
                >
                  <RefreshCw size={15} />
                  Try Again
                </button>
                <button
                  onClick={this.handleGoHome}
                  className="btn-primary flex items-center gap-2"
                >
                  <Home size={15} />
                  Go to Dashboard
                </button>
              </div>

              <p className="text-xs mt-6" style={{ color: 'var(--text-muted)' }}>
                If this problem persists, please contact support with the error details above.
              </p>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
