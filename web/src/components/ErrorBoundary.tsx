import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-wide last line of defense against a render-time throw. React unmounts the
 * ENTIRE component tree when a render throws and nothing catches it — a blank
 * white screen (exactly what a null factory address once did to the Launch
 * page). This boundary catches any such throw and shows a friendly, recoverable
 * fallback instead, so no future render error can ever blank the whole app.
 *
 * Individual pages still handle their own expected empty/unavailable states
 * gracefully (see the "not available on this network" notices) — this only
 * catches the truly-unexpected, and must never itself throw.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto max-w-xl p-6 text-ink"
        data-testid="app-error-boundary"
      >
        <h1 className="mb-2 text-2xl font-semibold">Something went wrong</h1>
        <p className="mb-4 text-ink-muted">
          The app hit an unexpected error and couldn&apos;t finish rendering this page. Your funds
          and data are unaffected — reloading usually clears it.
        </p>
        <pre className="mb-4 overflow-auto rounded-xl border border-border bg-surface p-3 text-sm text-rose">
          {error.message}
        </pre>
        <div className="flex gap-3">
          <button type="button" onClick={() => window.location.reload()} className="btn-primary">
            Reload
          </button>
          <a href="/" className="btn-ghost">
            Go home
          </a>
        </div>
      </div>
    );
  }
}
