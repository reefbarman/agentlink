import "../../agent/webview/styles/chat.css";
import "./styles.css";

import { BrowserGatewayApp } from "./BrowserGatewayApp";
import type { BrowserGatewayDataPlaneMode } from "../browserGatewayDataPlaneMode";
import type { BrowserGatewayThemeSnapshot } from "../../shared/types";
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
      initialTheme?: BrowserGatewayThemeSnapshot;
      dataPlaneMode?: BrowserGatewayDataPlaneMode;
    };
  }
}

function BrowserGatewayRoot() {
  const config = window.__AGENTLINK_BROWSER_GATEWAY__;
  if (!config) throw new Error("Browser gateway config missing");

  return (
    <BrowserGatewayApp
      authToken={config.authToken}
      currentInstanceId={config.currentInstanceId}
      workspaceName={config.workspaceName}
      routeByInstance={config.routeByInstance === true}
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
