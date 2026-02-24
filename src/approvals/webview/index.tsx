import { render } from "preact";
import { App } from "./App.js";
import "./styles/approval.css";

const vscodeApi = acquireVsCodeApi();

render(<App vscodeApi={vscodeApi} />, document.getElementById("root")!);
