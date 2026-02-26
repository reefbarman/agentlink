import { render } from "preact";
import { App } from "./App.js";
import "./styles/fr-preview.css";

const vscodeApi = acquireVsCodeApi();

render(<App vscodeApi={vscodeApi} />, document.getElementById("root")!);
