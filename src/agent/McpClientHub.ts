import * as vscode from "vscode";
import {
  McpClientHub as NodeMcpClientHub,
  type McpClientHubOptions,
  type McpHubHost,
} from "@agentlink/node-host";
import { McpOAuthProvider } from "./McpOAuthProvider.js";
import {
  buildAgentExecutionEnv,
  inheritProcessEnv,
} from "../process/agentExecutionPolicy.js";
import { agentLinkLongPollingFetch } from "../util/httpDispatcher.js";
import { createAgentPluginMcpFetch } from "./agentPluginHttpFetch.js";
import { buildAgentPluginStdioEnvironment } from "./agentPluginMcpRuntime.js";
import { AgentPluginSseClientTransport } from "./AgentPluginSseClientTransport.js";
import { inspectMcpOAuthResponse } from "./mcpOAuthErrorDiagnostic.js";

export type {
  McpClientHubOptions,
  McpConnectOptions,
  McpPrompt,
  McpResource,
  McpServerInfo,
  McpServerStatus,
  McpToolAuthorizationRequest,
  McpToolInfo,
  UrlElicitationAction,
} from "@agentlink/node-host";

/** Existing extension API, backed by the shared Node-host connection runtime. */
export class McpClientHub extends NodeMcpClientHub {
  constructor(
    globalState?: vscode.Memento,
    clientVersion = "unknown",
    options:
      | Readonly<McpClientHubOptions>
      | McpClientHubOptions["isConfigCurrent"] = {},
  ) {
    const host: McpHubHost = {
      authorizeNativeConnection: () => true,
      createOAuthProvider: globalState
        ? (name, url) => new McpOAuthProvider(name, url, globalState)
        : undefined,
      notify: async (level, message, action) =>
        level === "error"
          ? vscode.window.showErrorMessage(message, ...(action ? [action] : []))
          : vscode.window.showWarningMessage(
              message,
              ...(action ? [action] : []),
            ),
      baseEnvironment: () => ({
        ...inheritProcessEnv(),
        ...buildAgentExecutionEnv(),
      }),
      buildPluginEnvironment: buildAgentPluginStdioEnvironment,
      fetch: agentLinkLongPollingFetch,
      createNativeFetch: (config, baseFetch) => async (input, init) =>
        inspectMcpOAuthResponse(
          input,
          init,
          config.url!,
          await baseFetch(input, init),
          (message) => this.onLog?.(`[mcp:${config.name}] ${message}`),
        ),
      createPluginFetch: createAgentPluginMcpFetch,
      createPluginSseTransport: (url, transportOptions) =>
        new AgentPluginSseClientTransport(url, transportOptions),
      createSchemaValidator: async () => {
        const { AjvJsonSchemaValidator } =
          await import("@modelcontextprotocol/sdk/validation/ajv");
        return new AjvJsonSchemaValidator();
      },
    };
    super(host, clientVersion, options);
  }
}
