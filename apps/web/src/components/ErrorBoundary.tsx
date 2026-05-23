import { Component, type ReactNode } from "react";

/**
 * Catches render-time exceptions in children so a thrown error doesn't
 * silently unmount whole branches of the tree (which was making bugs in
 * the in-browser editor look like "the dialog just doesn't open" — no
 * error visible to the user, no React tree to debug).
 *
 * Use sparingly — wrap the editor / file detail / heavy widgets, not the
 * entire app. We want errors in critical chrome (the file list) to surface
 * fast.
 */
interface State {
  error: Error | null;
}

interface Props {
  children: ReactNode;
  fallback?: (error: Error, retry: () => void) => ReactNode;
  label?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // Keep this in console — the user can grab it for bug reports.
    console.error(`[ErrorBoundary ${this.props.label ?? ""}]`, error, info.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
      return (
        <div
          role="alert"
          style={{
            padding: 24,
            margin: 24,
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: 8,
            border: "1px solid #fca5a5"
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
            {this.props.label ?? "组件"}发生错误
          </div>
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.retry}
            style={{
              marginTop: 12,
              padding: "6px 12px",
              background: "#991b1b",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer"
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
