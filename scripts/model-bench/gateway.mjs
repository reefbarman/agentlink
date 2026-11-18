// Minimal client for one VS Code window's AgentLink browser-gateway bridge.
// The window registers its port and bearer token in
// ~/.agentlink/browser-gateways.json (mode 0600). The bench uses the same
// endpoints as the browser remote view, so runs go through the real VS Code
// chat: same prompt, tools, approvals and editor integration.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const REGISTRY_PATH = path.join(
  os.homedir(),
  ".agentlink",
  "browser-gateways.json",
);

/** The live registry record for the VS Code window that has `workspacePath` open. */
export async function findGatewayInstance(
  workspacePath,
  registryPath = REGISTRY_PATH,
) {
  let records;
  try {
    records = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    throw new Error(
      `No AgentLink browser-gateway registry at ${registryPath}. Open this folder in VS Code with AgentLink running.`,
    );
  }
  const target = path.resolve(workspacePath);
  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => path.resolve(record.workspacePath ?? "") === target)
    .filter((record) => record.port && record.authToken)
    .sort((a, b) =>
      String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")),
    );
  for (const record of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return record;
    } catch {
      // Stale record from a closed window; try the next one.
    }
  }
  throw new Error(
    `No running VS Code window with AgentLink has ${target} open. Open it (or reload the window) and retry.`,
  );
}

export function createGatewayClient(record) {
  const base = `http://127.0.0.1:${record.port}`;
  const headers = {
    authorization: `Bearer ${record.authToken}`,
    "content-type": "application/json",
  };
  async function call(method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    if (!response.ok || json?.ok === false) {
      const reason = json?.error ?? json?.reason ?? json?.raw ?? "";
      throw new Error(
        `${method} ${route} failed (HTTP ${response.status}) ${reason}`.trim(),
      );
    }
    return json;
  }
  return {
    getState: () => call("GET", "/api/ui-state"),
    newTab: (selection) => call("POST", "/api/tabs/new", { selection }),
    closeTab: (selection) =>
      call("POST", "/api/tabs/close", { selection, stopRunning: true }),
    setModel: (sessionId, model) =>
      call("POST", "/api/model", { sessionId, model }),
    setReasoningEffort: (sessionId, effort) =>
      call("POST", "/api/thinking", { sessionId, effort }),
    send: (sessionId, text, mode) =>
      call("POST", "/api/send", { sessionId, text, mode }),
    stop: (sessionId) => call("POST", "/api/stop", { sessionId }),
  };
}
