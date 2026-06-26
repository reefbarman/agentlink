import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { BrowserGatewayAskAgentPreferencesStore } from "./browserGatewayAskAgentPreferences.js";

async function makePreferencesPath(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentlink-ask-agent-preferences-"),
  );
  return path.join(dir, "preferences.json");
}

describe("BrowserGatewayAskAgentPreferencesStore", () => {
  it("persists and sanitizes Ask Agent model preferences", async () => {
    const filePath = await makePreferencesPath();
    const store = new BrowserGatewayAskAgentPreferencesStore({ filePath });

    expect(await store.read()).toEqual({});
    await store.update({
      model: " claude-sonnet-4-5 ",
      reasoningEffort: "high",
    });

    const reloaded = new BrowserGatewayAskAgentPreferencesStore({ filePath });
    expect(await reloaded.read()).toEqual({
      model: "claude-sonnet-4-5",
      reasoningEffort: "high",
    });

    await fs.writeFile(
      filePath,
      JSON.stringify({ model: " ", reasoningEffort: "invalid" }),
      "utf-8",
    );
    expect(await reloaded.read()).toEqual({});

    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });
});
