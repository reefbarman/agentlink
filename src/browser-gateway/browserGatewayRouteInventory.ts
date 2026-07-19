export type BrowserGatewayAuthPolicy =
  | "public"
  | "instance-bearer"
  | "browser-session"
  | "helper-shared-secret"
  | "instance-bearer+helper-shared-secret";

export interface BrowserGatewayRouteFamily {
  surface: "vscode-gateway" | "helper";
  methods: readonly string[];
  pathClass: string;
  auth: BrowserGatewayAuthPolicy;
  notes?: string;
}

export const BROWSER_GATEWAY_ROUTE_FAMILIES = [
  {
    surface: "vscode-gateway",
    methods: ["GET"],
    pathClass: "/health, /api/ui-state, /api/instances, /events",
    auth: "public",
    notes: "Loopback per-window server; the helper protects proxied access.",
  },
  {
    surface: "vscode-gateway",
    methods: ["GET", "POST", "DELETE"],
    pathClass:
      "/api/* except public reads; /internal/ask-agent/* except sensitive MCP mutations",
    auth: "instance-bearer",
  },
  {
    surface: "vscode-gateway",
    methods: ["POST", "DELETE"],
    pathClass: "/internal/ask-agent/mcp-config/server",
    auth: "instance-bearer+helper-shared-secret",
    notes:
      "The helper also supplies its socket-derived loopback/non-loopback classification; public browser mutation routes are rejected.",
  },
  {
    surface: "helper",
    methods: ["GET", "POST"],
    pathClass: "/health, /pair, static assets, bootstrap root",
    auth: "public",
    notes:
      "Loopback bootstrap may issue a browser session cookie; LAN pairing does not require one.",
  },
  {
    surface: "helper",
    methods: ["GET", "POST", "DELETE"],
    pathClass: "/api/ask-agent/*, /api/instances, /api/* proxy, /events",
    auth: "browser-session",
  },
  {
    surface: "helper",
    methods: ["GET", "POST"],
    pathClass: "/internal/*",
    auth: "helper-shared-secret",
  },
] as const satisfies readonly BrowserGatewayRouteFamily[];
