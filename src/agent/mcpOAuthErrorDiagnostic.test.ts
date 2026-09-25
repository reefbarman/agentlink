import { describe, expect, it, vi } from "vitest";

import { inspectMcpOAuthResponse } from "./mcpOAuthErrorDiagnostic.js";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";

const server = "https://mcp.example.test/admin-mcp";

const registration = "https://auth.example.test/register?code=never-log";

function oauthResponse(body: string, status = 400): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("inspectMcpOAuthResponse", () => {
  it("reports a registration error without exposing unknown response details", async () => {
    const log = vi.fn();
    const response = await inspectMcpOAuthResponse(
      registration,
      { method: "POST", headers: { "content-type": "application/json" } },
      server,
      oauthResponse(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description:
            "Client authentication method is unsupported. secret=do-not-log code=do-not-log",
        }),
      ),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      "oauth endpoint=registration status=400 error=invalid_client_metadata description=unsupported_client_authentication_method",
    );
    const error = await parseErrorResponse(response);
    expect(error.message).toContain("unsupported_client_authentication_method");
    expect(error.message).not.toContain("do-not-log");
    expect(JSON.stringify(log.mock.calls)).not.toContain("do-not-log");
    expect(JSON.stringify(log.mock.calls)).not.toContain("code=never-log");
  });

  it("recognises token_endpoint_auth_method registration rejections", async () => {
    const log = vi.fn();
    const response = await inspectMcpOAuthResponse(
      registration,
      { method: "POST", headers: { "content-type": "application/json" } },
      server,
      oauthResponse(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description:
            "token_endpoint_auth_method must be client_secret_basic, got none (client=do-not-log)",
        }),
      ),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      "oauth endpoint=registration status=400 error=invalid_client_metadata description=unsupported_token_endpoint_auth_method",
    );
    const error = await parseErrorResponse(response);
    expect(error.message).toBe("unsupported_token_endpoint_auth_method");
    expect(JSON.stringify(log.mock.calls)).not.toContain("do-not-log");
  });

  it("preserves a discovery 404 for SDK fallback", async () => {
    const log = vi.fn();
    const original = oauthResponse('{"anything":"secret"}', 404);
    const response = await inspectMcpOAuthResponse(
      "https://mcp.example.test/.well-known/oauth-authorization-server/admin-mcp",
      undefined,
      server,
      original,
      log,
    );
    expect(response).toBe(original);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps safe OAuth diagnostics stable through a second fetch adapter", async () => {
    const log = vi.fn();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const original = new Response(
      JSON.stringify({
        error: "invalid_redirect_uri",
        error_description:
          "Invalid redirect URI: http://localhost:4000/callback?code=hidden",
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "retry-after": "30",
          "set-cookie": "secret=hidden",
        },
      },
    );
    const first = await inspectMcpOAuthResponse(
      registration,
      request,
      server,
      original,
      log,
    );
    const second = await inspectMcpOAuthResponse(
      registration,
      request,
      server,
      first,
      log,
    );
    expect(second.headers.get("retry-after")).toBe("30");
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "oauth endpoint=registration status=400 error=invalid_redirect_uri description=invalid redirect uri",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("localhost");
    const error = await parseErrorResponse(second);
    expect(error.message).toContain("invalid redirect uri");
    expect(error.message).not.toContain("localhost");
  });

  it("leaves SSE message errors and their challenge headers untouched", async () => {
    const log = vi.fn();
    const original = new Response("challenge", {
      status: 401,
      headers: { "www-authenticate": 'Bearer scope="read"' },
    });
    const response = await inspectMcpOAuthResponse(
      "https://mcp.example.test/message",
      { method: "POST", headers: { "content-type": "application/json" } },
      server,
      original,
      log,
    );
    expect(response).toBe(original);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer scope="read"',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("does not leak unknown codes, descriptions, or full request URLs", async () => {
    const log = vi.fn();
    const response = await inspectMcpOAuthResponse(
      "https://auth.example.test/token?state=private",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      server,
      oauthResponse(
        JSON.stringify({
          error: "private_value",
          error_description: "token=secret",
        }),
      ),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      "oauth endpoint=token status=400 error=server_error description=redacted",
    );
    expect(await response.text()).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
});
