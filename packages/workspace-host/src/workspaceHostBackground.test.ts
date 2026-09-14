import { describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";
import { createWorkspaceHost } from "./workspaceHost.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function toolCall(name: string, input: Record<string, unknown>): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: `response-${name}`,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${name}`,
                type: "function",
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function completion(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      id: "response-complete",
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: "stop",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("workspace host background composition", () => {
  it("spawns a scoped one-level child and mediates its write through the parent", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-"),
    );
    const projectRoot = path.join(root, "project");
    const dataRoot = path.join(root, "data");
    const filePath = path.join(projectRoot, "child.txt");
    await fs.mkdir(projectRoot);
    await fs.writeFile(filePath, "before\n", "utf8");
    const expectedContentHash = createHash("sha256")
      .update("before\n")
      .digest("hex");
    const seenTools: string[][] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const names =
        body.tools?.flatMap((tool) =>
          tool.function?.name ? [tool.function.name] : [],
        ) ?? [];
      seenTools.push(names);
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const hasToolResult = body.messages?.some(
        (message) => message.role === "tool",
      );
      if (lastUser === "delegate child" && !hasToolResult) {
        return toolCall("spawn_background_agent", {
          task: "Update child file",
          message: "write child file",
          read_paths: [],
          write_paths: [{ path: "child.txt", kind: "file" }],
        });
      }
      if (lastUser === "write child file" && !hasToolResult) {
        expect(names).not.toContain("spawn_background_agent");
        return toolCall("write_file", {
          path: "child.txt",
          content: "after\n",
          expectedContentHash,
        });
      }
      return completion(
        lastUser === "write child file" ? "child done" : "parent done",
      );
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot,
      ownerId: "background-composition",
      providers: [
        {
          type: "openai-compatible",
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true,
          models: [
            {
              id: "fixture-model",
              contextWindow: 32_768,
              maxOutputTokens: 4_096,
              supportsToolUse: true,
            },
          ],
          fetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
      background: { enabled: true },
    });
    try {
      const parentSessionId = (
        await host.createSession({ sessionId: "parent-session" })
      ).sessionId;
      await expect(
        host.runTurn(parentSessionId, "delegate child"),
      ).resolves.toMatchObject({ status: "completed", text: "parent done" });
      await vi.waitFor(() => {
        expect(host.listBackgroundApprovals(parentSessionId)).toHaveLength(1);
      });
      const child = host.listBackgroundApprovals(parentSessionId)[0]!;
      expect(child).toMatchObject({
        parentSessionId,
        depth: 1,
        lifecycle: "awaiting_approval",
        approval: {
          source: "durable_interaction",
          toolName: "write_file",
          displayContent: { path: "child.txt" },
        },
      });
      await expect(host.listSessions()).resolves.not.toContainEqual(
        expect.objectContaining({ sessionId: child.childSessionId }),
      );
      await expect(
        host.runTurn(child.childSessionId, "bypass supervisor"),
      ).rejects.toThrow("background_child_requires_supervisor_control");
      expect(await fs.readFile(filePath, "utf8")).toBe("before\n");
      await host.respondToBackgroundApproval({
        callerSessionId: parentSessionId,
        childSessionId: child.childSessionId,
        interactionId: child.approval!.interactionId,
        decision: "allow",
      });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(parentSessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultState: "completed",
          resultText: "child done",
        });
      });
      expect(await fs.readFile(filePath, "utf8")).toBe("after\n");
      expect(
        seenTools.some((names) => names.includes("spawn_background_agent")),
      ).toBe(true);
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
