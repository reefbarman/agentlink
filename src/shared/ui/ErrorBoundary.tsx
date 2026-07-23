import { Component, Fragment } from "preact";

import type { ComponentChildren } from "preact";

export interface ErrorBoundaryProps {
  children: ComponentChildren;
  title?: string;
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: string | null;
  retryKey: number;
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack ? `${error.message}\n\n${error.stack}` : error.message;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, retryKey: 0 };

  componentDidCatch(error: unknown): void {
    this.setState({ error: formatError(error) });
  }

  private readonly retry = (): void => {
    this.setState((state) => ({
      error: null,
      retryKey: state.retryKey + 1,
    }));
  };

  private readonly reload = (): void => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <main
          style={{
            boxSizing: "border-box",
            display: "flex",
            minHeight: "100%",
            padding: "24px",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--vscode-foreground, #cccccc)",
            background: "var(--vscode-editor-background, #1e1e1e)",
          }}
        >
          <section style={{ width: "min(100%, 680px)" }}>
            <div role="alert">
              <h1 style={{ margin: "0 0 8px", fontSize: "18px" }}>
                {this.props.title ?? "Agent render error"}
              </h1>
              <p style={{ margin: "0 0 16px" }}>
                The interface stopped rendering. Retry the view or reload it to
                recover.
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
              <button type="button" onClick={this.retry}>
                Retry
              </button>
              <button type="button" onClick={this.reload}>
                Reload
              </button>
            </div>
            <details>
              <summary>Error details</summary>
              <pre
                style={{
                  overflow: "auto",
                  margin: "8px 0 0",
                  padding: "12px",
                  border: "1px solid var(--vscode-panel-border, #454545)",
                  borderRadius: "4px",
                  color: "var(--vscode-errorForeground, #f85149)",
                  background: "var(--vscode-textCodeBlock-background, #181818)",
                  fontSize: "11px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {this.state.error}
              </pre>
            </details>
          </section>
        </main>
      );
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }
}
