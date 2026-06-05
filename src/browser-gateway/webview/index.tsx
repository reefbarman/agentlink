import "../../agent/webview/styles/chat.css";
import "./styles.css";

import { BrowserGatewayApp } from "./BrowserGatewayApp";
import type { BrowserGatewayThemeSnapshot } from "../../shared/types";
import { render } from "preact";

declare global {
  interface Window {
    __AGENTLINK_BROWSER_GATEWAY__?: {
      authToken: string;
      currentInstanceId: string;
      workspaceName: string;
      routeByInstance?: boolean;
      initialTheme?: BrowserGatewayThemeSnapshot;
    };
  }
}

const config = window.__AGENTLINK_BROWSER_GATEWAY__;

if (!config) {
  throw new Error("Browser gateway config missing");
}

render(
  <BrowserGatewayApp
    authToken={config.authToken}
    currentInstanceId={config.currentInstanceId}
    workspaceName={config.workspaceName}
    routeByInstance={config.routeByInstance === true}
    initialTheme={config.initialTheme}
  />,
  document.getElementById("root")!,
);
