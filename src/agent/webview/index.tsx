import { render, Component } from "preact";
import type { ComponentChildren } from "preact";
import { App } from "./App";
import "./styles/chat.css";

class ErrorBoundary extends Component<
  { children: ComponentChildren },
  { error: string | null }
> {
  state = { error: null };
  componentDidCatch(err: unknown) {
    const msg =
      err instanceof Error ? `${err.message}\n\n${err.stack}` : String(err);
    this.setState({ error: msg });
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "12px",
            color: "var(--vscode-errorForeground)",
            fontFamily: "monospace",
            fontSize: "11px",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>Agent render error:</strong>
          {"\n"}
          {this.state.error}
        </div>
      );
    }
    return this.props.children;
  }
}

const vscodeApi = acquireVsCodeApi();

render(
  <ErrorBoundary>
    <App vscodeApi={vscodeApi} />
  </ErrorBoundary>,
  document.getElementById("root")!,
);
