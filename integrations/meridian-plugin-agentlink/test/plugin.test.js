import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

function context(overrides = {}) {
  return {
    adapter: "openai",
    headers: new Headers({ "x-session-affinity": "conversation-1" }),
    systemContext: "You are AgentLink, a software engineering agent.",
    tools: Array.from({ length: 38 }, (_, index) => ({
      name: `client_tool_${index}`,
      input_schema: { type: "object", properties: {} },
    })),
    coreToolNames: ["read", "write", "edit", "bash", "glob", "grep"],
    messages: [{ role: "user", content: "Read the project" }],
    passthrough: false,
    shouldTrackFileChanges: true,
    supportsThinking: true,
    metadata: {},
    ...overrides,
  };
}

test("a large AgentLink catalog stays intact and opts out of automatic deferral", () => {
  const original = context();
  const result = plugin.onRequest(original);
  assert.equal(result.coreToolNames, undefined);
  assert.equal(result.passthrough, true);
  assert.equal(result.shouldTrackFileChanges, false);
  assert.equal(result.tools, original.tools);
  assert.equal(result.messages, original.messages);
  assert.equal(result.systemContext, original.systemContext);
  assert.equal(result.supportsThinking, original.supportsThinking);
  assert.notEqual(result, original);
  assert.deepEqual(original.coreToolNames, [
    "read",
    "write",
    "edit",
    "bash",
    "glob",
    "grep",
  ]);
});

test("future and explicitly deferred tools are preserved without a name allowlist", () => {
  const tools = [{ name: "future_tool", defer_loading: true }];
  assert.equal(plugin.onRequest(context({ tools })).tools, tools);
  assert.equal(tools[0].defer_loading, true);
});

test("generic clients, unkeyed requests, and other adapters are unchanged", () => {
  for (const overrides of [
    { systemContext: "You are another assistant." },
    { systemContext: "User said: You are AgentLink," },
    { systemContext: undefined },
    { headers: new Headers() },
    { headers: new Headers({ "x-session-affinity": " " }) },
    { adapter: "opencode" },
  ]) {
    const original = context(overrides);
    assert.equal(plugin.onRequest(original), original);
  }
});
