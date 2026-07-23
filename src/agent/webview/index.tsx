import "./styles/chat.css";

import { App } from "./App";
import { ErrorBoundary } from "../../shared/ui/ErrorBoundary";
import { render } from "preact";

const vscodeApi = acquireVsCodeApi();

render(
  <ErrorBoundary>
    <App vscodeApi={vscodeApi} />
  </ErrorBoundary>,
  document.getElementById("root")!,
);
