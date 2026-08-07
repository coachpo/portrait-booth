/**
 * Global error boundary.
 *
 * Without it, any exception thrown during render unmounts the whole tree -
 * the user sees a blank screen with neither an explanation nor a way home.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log only the error and component stack, never photo data or KEYs
    // (§9.4 field whitelist)
    console.error("[portrait-booth] render failed", error.message, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section aria-label="Something went wrong" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted">
          This step could not be displayed. Your photo exists only in this session's memory and will
          not be uploaded or retained because of this error.
        </p>
        <p className="muted">Error: {error.message}</p>
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
          <button type="button" onClick={() => (window.location.href = "/")}>
            Back to home
          </button>
        </div>
      </section>
    );
  }
}
