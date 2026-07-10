import { render } from "preact";
import { App } from "./App";
import "./styles/sidebar.css";

// acquireVsCodeApi must be called exactly once per webview lifetime
const vscodeApi = acquireVsCodeApi() as ReturnType<typeof acquireVsCodeApi> & {
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): T;
};

render(<App vscodeApi={vscodeApi} />, document.getElementById("root")!);
