import "../../agent/webview/styles/chat.css";
import "./styles.css";

import { BrowserGatewayApp } from "./BrowserGatewayApp";
import type { BrowserGatewayDataPlaneMode } from "../browserGatewayDataPlaneMode";
import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";
import { ErrorBoundary } from "../../shared/ui/ErrorBoundary";
import { installClipboardShim } from "./installClipboardShim";
import { render } from "preact";

// The gateway is served over plain HTTP locally, so `navigator.clipboard` is
// absent. Install a fallback before Monaco/app code touches the clipboard.
installClipboardShim();

declare global {
  interface Window {
    __AGENTLINK_BROWSER_GATEWAY__?: {
      authToken: string;
      currentInstanceId: string;
      workspaceName: string;
      routeByInstance?: boolean;
      askAgentOnly?: boolean;
      initialTheme?: BrowserGatewayThemeSnapshot;
      dataPlaneMode?: BrowserGatewayDataPlaneMode;
    };
  }
}

function BrowserGatewayRoot() {
  const config = window.__AGENTLINK_BROWSER_GATEWAY__;
  if (!config) throw new Error("Browser gateway config missing");
  const query = new URLSearchParams(window.location.search);
  const desktopWorkspace = query.get("desktopWorkspace") === "1";
  const workspaceOnly =
    config.routeByInstance === true &&
    config.askAgentOnly !== true &&
    (desktopWorkspace || query.get("browserWorkspace") === "1");

  return (
    <BrowserGatewayApp
      authToken={config.authToken}
      currentInstanceId={config.currentInstanceId}
      workspaceName={config.workspaceName}
      routeByInstance={config.routeByInstance === true}
      askAgentOnly={config.askAgentOnly === true}
      workspaceOnly={workspaceOnly}
      externalBrowserUnavailable={workspaceOnly && desktopWorkspace}
      browserShell={
        config.routeByInstance === true &&
        config.askAgentOnly !== true &&
        !workspaceOnly
      }
      initialTheme={config.initialTheme}
      dataPlaneMode={config.dataPlaneMode}
    />
  );
}

render(
  <ErrorBoundary title="Browser gateway render error">
    <BrowserGatewayRoot />
  </ErrorBoundary>,
  document.getElementById("root")!,
);
