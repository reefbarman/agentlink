import { render } from "preact";
import { App } from "./App";
import "./styles/sidebar.css";

// acquireVsCodeApi must be called exactly once per webview lifetime
const vscodeApi = acquireVsCodeApi();

render(<App vscodeApi={vscodeApi} />, document.getElementById("root")!);
