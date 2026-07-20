import "@xterm/xterm/css/xterm.css";
import "./styles/terminal.css";

import { App } from "./App.js";
import { render } from "preact";

const vscodeApi = acquireVsCodeApi();

render(<App vscodeApi={vscodeApi} />, document.getElementById("root")!);
