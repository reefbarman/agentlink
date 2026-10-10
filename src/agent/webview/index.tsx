import "./styles/chat.css";
import "./styles/voice-input.css";

import { App } from "./App";
import { ErrorBoundary } from "../../shared/ui/ErrorBoundary";
import { createSerializedChatPanelState } from "../chatPaneProtocol";
import { installImageContextMenuCopy } from "./imageClipboard";
import { parseChatWebviewBootstrap } from "@agentlink/protocol/chat-pane-transport";
import { render } from "preact";

const vscodeApi = acquireVsCodeApi();
const bootstrapElement = document.getElementById("agentlink-chat-bootstrap");
const parsedBootstrap = bootstrapElement?.textContent
  ? parseChatWebviewBootstrap(JSON.parse(bootstrapElement.textContent))
  : null;
const pane = parsedBootstrap ?? { surface: "sidebar" as const };

installImageContextMenuCopy();

if (pane.surface === "editor") {
  vscodeApi.setState(createSerializedChatPanelState(pane.address.tabId));
}

render(
  <ErrorBoundary>
    <App vscodeApi={vscodeApi} pane={pane} />
  </ErrorBoundary>,
  document.getElementById("root")!,
);
