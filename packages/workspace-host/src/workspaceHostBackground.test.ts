import {
  EXPECTED_RESULT_PROPERTY,
  REVIEW_SCOPE_PROPERTY,
} from "@agentlink/core/background-agent-tools";
import { describe, expect, it, vi } from "vitest";
import {
  formatFleetResultEnvelope,
  withFleetResultInstruction,
} from "@agentlink/core/background-results";

import type { WorkspaceBackgroundChange } from "./backgroundSupervisor.js";
import { createHash } from "node:crypto";
import { createWorkspaceHost } from "./workspaceHostRuntime.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceBackgroundOutcome } from "./backgroundTools.js";

// These fixtures each spawn one child. Subscribe before starting the parent
// so even a child that finishes before runTurn returns is observed.
function backgroundEvents() {
  let onApprovalAvailable!: () => void;
  const approvalAvailable = new Promise<void>((resolve) => {
    onApprovalAvailable = resolve;
  });
  let onAgentChanged!: (change: WorkspaceBackgroundChange) => void;
  const settled = new Promise<void>((resolve) => {
    onAgentChanged = ({ lifecycle }) => {
      // Wake on unsuccessful terminal states too, so the result assertions
      // report a failed child rather than waiting for the test timeout.
      if (
        lifecycle === "completed" ||
        lifecycle === "failed" ||
        lifecycle === "cancelled" ||
        lifecycle === "interrupted"
      ) {
        resolve();
      }
    };
  });
  return {
    approvalAvailable,
    settled,
    callbacks: { onApprovalAvailable, onAgentChanged },
  };
}

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
    const events = backgroundEvents();
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
      background: { enabled: true, ...events.callbacks },
    });
    try {
      const parentSessionId = (
        await host.createSession({ sessionId: "parent-session" })
      ).sessionId;
      await expect(
        host.runTurn(parentSessionId, "delegate child"),
      ).resolves.toMatchObject({ status: "completed", text: "parent done" });
      await events.approvalAvailable;
      expect(host.listBackgroundApprovals(parentSessionId)).toHaveLength(1);
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
      await events.settled;
      expect(host.listBackgroundAgents(parentSessionId)[0]).toMatchObject({
        lifecycle: "completed",
        resultState: "completed",
        resultText: "child done",
      });
      expect(await fs.readFile(filePath, "utf8")).toBe("after\n");
      expect(
        seenTools.some((names) => names.includes("spawn_background_agent")),
      ).toBe(true);
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // Durable parent/child turns and real file approval/write work.

  it("answers the background tools with VS Code's payloads, including several-agent waits and the legacy child id", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-shapes-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "notes.md"), "notes\n");
    const parentToolResults: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const messages = body.messages ?? [];
      const lastUserIndex = messages.findLastIndex(
        (message) => message.role === "user",
      );
      const lastUser = messages[lastUserIndex]?.content ?? "";
      const results = messages
        .slice(lastUserIndex + 1)
        .filter((message) => message.role === "tool")
        .map((message): unknown => {
          try {
            return JSON.parse(String(message.content));
          } catch {
            return message.content;
          }
        });
      if (lastUser === "inspect notes") return completion("child found it");
      if (lastUser === "delegate") {
        return results.length === 0
          ? toolCall("spawn_background_agent", {
              task: "Inspect notes",
              message: "inspect notes",
              read_paths: [{ path: "notes.md", kind: "file" }],
              write_paths: [],
            })
          : completion("spawned");
      }
      const childId = lastUser.replace(/^check /u, "");
      const steps = [
        () =>
          toolCall("get_background_result", {
            sessionIds: [childId],
            return_when: "all",
            wait_seconds: 5,
          }),
        () =>
          toolCall("get_background_result", {
            sessionId: childId,
            wait_seconds: 1,
          }),
        () => toolCall("get_background_status", { child_session_id: childId }),
        () => toolCall("get_background_status", { sessionId: "missing-id" }),
      ];
      const next = steps[results.length];
      if (next) return next();
      parentToolResults.push(...results);
      return completion("checked");
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-shapes",
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
      const { sessionId } = await host.createSession();
      await expect(host.runTurn(sessionId, "delegate")).resolves.toMatchObject({
        status: "completed",
      });
      const childId = host.listBackgroundAgents(sessionId)[0]!.childSessionId;
      await expect(
        host.runTurn(sessionId, `check ${childId}`),
      ).resolves.toMatchObject({ status: "completed", text: "checked" });
      const [several, single, legacyStatus, missing] = parentToolResults;
      expect(several).toMatchObject({
        status: "completed",
        returnWhen: "all",
        done: true,
        completed: [
          {
            sessionId: childId,
            result: "child found it",
            resultState: "completed",
            retrySafe: true,
            agentRetryable: false,
          },
        ],
        pending: [],
      });
      // A finished single wait returns the child's final text, as in VS Code.
      expect(single).toBe("child found it");
      expect(legacyStatus).toMatchObject({
        status: "idle",
        done: true,
        phase: "completed",
        resultState: "completed",
        canSteer: false,
        canKill: false,
        sessionId: childId,
        task: "Inspect notes",
        scopes: [{ path: "notes.md", kind: "file", access: "read" }],
      });
      expect(missing).toMatchObject({
        status: "error",
        done: true,
        resultState: "failed",
        terminalReason: "background_session_not_found",
        retrySafe: true,
      });
      expect((missing as { partialOutput: string }).partialOutput).toContain(
        childId,
      );
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a child's writes inside its ownedPaths and out of its forbiddenPaths", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-owned-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "README.md"), "readme\n");
    const childFirstMessages: string[] = [];
    const childResults: string[] = [];
    let spawnDescription = "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string; description?: string } }>;
      };
      const messages = body.messages ?? [];
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      const results = messages.filter((m) => m.role === "tool");
      if (firstUser.startsWith("write the files")) {
        if (results.length === 0) childFirstMessages.push(firstUser);
        const writes = [
          { path: "outside.txt", content: "no\n", expectedAbsent: true },
          { path: "src/secret.txt", content: "no\n", expectedAbsent: true },
          { path: "src/ok.txt", content: "yes\n", expectedAbsent: true },
        ];
        const next = writes[results.length];
        if (next) return toolCall("write_file", next);
        childResults.push(...results.map((m) => String(m.content)));
        return completion("child done");
      }
      spawnDescription =
        body.tools?.find((t) => t.function?.name === "spawn_background_agent")
          ?.function?.description ?? spawnDescription;
      return results.length === 0
        ? toolCall("spawn_background_agent", {
            task: "Write src",
            message: "write the files",
            ownedPaths: ["src/"],
            forbiddenPaths: ["src/secret.txt"],
          })
        : completion("parent done");
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-owned",
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
      files: {
        enabled: true,
        approvalPolicy: { hasSessionGrant: () => true },
      },
      background: {
        enabled: true,
        inheritSessionGrants: true,
        maxActiveChildren: 4,
      },
    });
    try {
      const { sessionId } = await host.createSession();
      await expect(host.runTurn(sessionId, "delegate")).resolves.toMatchObject({
        status: "completed",
      });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultText: "child done",
        });
      });
      const [child] = host.listBackgroundAgents(sessionId);
      // The whole project is readable; only src/ is writable.
      expect(child!.scopes).toEqual([
        { path: ".", kind: "directory", access: "read" },
        { path: "src", kind: "directory", access: "read_write" },
      ]);
      expect(child!.forbidden).toEqual([
        { path: "src/secret.txt", kind: "file" },
      ]);
      expect(spawnDescription).toContain("At most 4 children");
      // VS Code's ownership handoff, in the workspace host's wording.
      expect(childFirstMessages[0]).toContain("## Delegated file ownership");
      expect(childFirstMessages[0]).toContain(
        '"ownedPaths":["src"],"forbiddenPaths":["src/secret.txt"]',
      );
      expect(childFirstMessages[0]).toContain(
        "an empty ownedPaths list means you cannot write files at all",
      );
      expect(childResults).toHaveLength(3);
      await expect(
        fs.access(path.join(projectRoot, "outside.txt")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(projectRoot, "src", "secret.txt")),
      ).rejects.toThrow();
      await expect(
        fs.readFile(path.join(projectRoot, "src", "ok.txt"), "utf8"),
      ).resolves.toBe("yes\n");
      expect(childResults[0]).toContain("outside the active write scope");
      expect(childResults[1]).toContain("forbiddenPaths");
      expect(childResults[2]).toContain('"operation":"created"');
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets a child without read_paths read only what its narrower parent can", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-narrow-"),
    );
    const events = backgroundEvents();
    const projectRoot = path.join(root, "project");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const messages = body.messages ?? [];
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      if (firstUser.startsWith("child")) return completion("child done");
      return messages.some((m) => m.role === "tool")
        ? completion("parent done")
        : toolCall("spawn_background_agent", {
            task: "Narrow",
            message: "child work",
            ownedPaths: ["src/a.ts"],
          });
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-narrow",
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
      files: {
        enabled: true,
        resolveScopes: async () => [
          { path: "src", kind: "directory", access: "read_write" },
        ],
      },
      background: { enabled: true, ...events.callbacks },
    });
    try {
      const { sessionId } = await host.createSession();
      await host.runTurn(sessionId, "delegate");
      await events.settled;
      expect(host.listBackgroundAgents(sessionId)[0]).toMatchObject({
        lifecycle: "completed",
        scopes: [
          { path: "src", kind: "directory", access: "read" },
          { path: "src/a.ts", kind: "file", access: "read_write" },
        ],
      });
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000); // Durable parent/child turns and real filesystem scope resolution.

  it("refuses a child limit above eight", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-limit-"),
    );
    try {
      await expect(
        createWorkspaceHost({
          projectRoot: root,
          dataRoot: path.join(root, ".data"),
          ownerId: "background-limit",
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
              fetch: vi.fn<typeof globalThis.fetch>(),
            },
          ],
          defaultModel: { providerId: "fixture", modelId: "fixture-model" },
          files: { enabled: true },
          background: { enabled: true, maxActiveChildren: 9 },
        }),
      ).rejects.toThrow("background_max_active_children_invalid");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs a read-only reviewer on the configured review model", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-review-"),
    );
    const projectRoot = path.join(root, "project");
    const filePath = path.join(projectRoot, "math.js");
    await fs.mkdir(projectRoot);
    await fs.writeFile(filePath, "export const add = (a, b) => a - b;\n");
    const parentFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{
          function?: {
            name?: string;
            parameters?: { properties?: Record<string, unknown> };
          };
        }>;
      };
      const spawn = body.tools?.find(
        (tool) => tool.function?.name === "spawn_background_agent",
      );
      expect(spawn?.function?.parameters?.properties?.model_role).toEqual({
        type: "string",
        enum: ["review"],
      });
      if (!body.messages?.some((message) => message.role === "tool")) {
        return toolCall("spawn_background_agent", {
          task: "Review math.js",
          message: "review math.js",
          read_paths: [{ path: "math.js", kind: "file" }],
          write_paths: [],
          model_role: "review",
        });
      }
      return completion("parent done");
    });
    const reviewRequests: Array<{ model: string; tools: string[] }> = [];
    const reviewFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      reviewRequests.push({
        model: body.model,
        tools:
          body.tools?.flatMap((tool) =>
            tool.function?.name ? [tool.function.name] : [],
          ) ?? [],
      });
      const toolResults =
        body.messages?.filter((message) => message.role === "tool") ?? [];
      if (toolResults.length === 0) {
        return toolCall("write_file", {
          path: "math.js",
          content: "export const add = (a, b) => a + b;\n",
          expectedContentHash: createHash("sha256")
            .update("export const add = (a, b) => a - b;\n")
            .digest("hex"),
        });
      }
      return completion("add subtracts instead of adding");
    });
    const model = (id: string) => ({
      id,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      supportsToolUse: true,
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-review",
      providers: [
        {
          type: "openai-compatible",
          id: "fixture",
          baseURL: "https://example.invalid/v1",
          noAuth: true,
          models: [model("fixture-model")],
          fetch: parentFetch,
        },
        {
          type: "openai-compatible",
          id: "claude",
          baseURL: "https://claude.invalid/v1",
          noAuth: true,
          models: [model("review-model")],
          fetch: reviewFetch,
        },
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
      background: {
        enabled: true,
        modelRoles: {
          review: { providerId: "claude", modelId: "review-model" },
        },
      },
    });
    try {
      const { sessionId } = await host.createSession();
      await expect(
        host.runTurn(sessionId, "get a review"),
      ).resolves.toMatchObject({ status: "completed" });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultText: "add subtracts instead of adding",
          model: { providerId: "claude", modelId: "review-model" },
          scopes: [{ path: "math.js", kind: "file", access: "read" }],
        });
      });
      // The reviewer ran only on the review model and could not write,
      // and its write did not wait for an approval either.
      expect(reviewRequests.length).toBeGreaterThanOrEqual(2);
      expect(reviewRequests.every((r) => r.model === "review-model")).toBe(
        true,
      );
      expect(reviewRequests[0]!.tools).not.toContain("spawn_background_agent");
      expect(host.listBackgroundApprovals(sessionId)).toEqual([]);
      expect(await fs.readFile(filePath, "utf8")).toBe(
        "export const add = (a, b) => a - b;\n",
      );
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("briefs a reviewer on its reviewScope and holds it to VS Code's expectedResult envelope", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-expected-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "math.js"),
      "export const add = (a, b) => a - b;\n",
    );
    const parentToolResults: string[] = [];
    const childToolResults: string[] = [];
    let childBrief = "";
    let childResultSchema: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{
          function?: {
            name?: string;
            parameters?: { properties?: Record<string, unknown> };
          };
        }>;
      };
      const messages = body.messages ?? [];
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      const results = messages
        .filter((message) => message.role === "tool")
        .map((message) => String(message.content));
      if (firstUser.startsWith("## Review goal")) {
        childBrief = firstUser;
        childResultSchema = body.tools?.find(
          (tool) => tool.function?.name === "set_task_status",
        )?.function?.parameters?.properties?.result;
        childToolResults.splice(0, Infinity, ...results);
        if (results.length === 0) {
          // Missing emptyDiff: refused, and the child keeps going.
          return toolCall("set_task_status", {
            status: "completed",
            result: { type: "review_findings", findings: [] },
          });
        }
        return toolCall("set_task_status", {
          status: "completed",
          result: {
            type: "review_findings",
            findings: [
              {
                severity: "high",
                message: "add subtracts",
                path: "math.js",
                line: 1,
              },
            ],
            emptyDiff: false,
          },
        });
      }
      parentToolResults.splice(0, Infinity, ...results);
      if (firstUser === "missing review" && results.length === 0) {
        return toolCall("spawn_background_agent", {
          task: "Review gone.js",
          message: "review gone.js",
          reviewScope: { kind: "files", paths: ["gone.js"] },
        });
      }
      if (firstUser === "review math" && results.length === 0) {
        const spawn = body.tools?.find(
          (tool) => tool.function?.name === "spawn_background_agent",
        );
        expect(spawn?.function?.parameters?.properties).toMatchObject({
          reviewScope: REVIEW_SCOPE_PROPERTY,
          expectedResult: EXPECTED_RESULT_PROPERTY,
        });
        return toolCall("spawn_background_agent", {
          task: "Review math.js",
          message: "check add",
          reviewScope: { kind: "files", paths: ["math.js"] },
          expectedResult: "review_findings",
        });
      }
      return completion("parent done");
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-expected",
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
      sessionInteractions: { finalStatus: true },
      background: { enabled: true },
    });
    try {
      const missing = await host.createSession();
      await host.runTurn(missing.sessionId, "missing review");
      expect(parentToolResults[0]).toContain(
        "Live review file target is unavailable: gone.js",
      );
      expect(host.listBackgroundAgents(missing.sessionId)).toEqual([]);

      const { sessionId } = await host.createSession();
      await expect(
        host.runTurn(sessionId, "review math"),
      ).resolves.toMatchObject({ status: "completed" });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultState: "completed",
          expectedResult: "review_findings",
          reviewScopeSummary: "current files: math.js",
          structuredResult: {
            type: "review_findings",
            reviewedScope: "current files: math.js",
            emptyDiff: false,
          },
        });
      });
      const child = host.listBackgroundAgents(sessionId)[0]!;
      expect(child.resultText).toBe(
        formatFleetResultEnvelope(child.structuredResult!),
      );
      expect(child.resultText).toContain("**Review found 1 issue.**");
      // VS Code's review brief around the captured target.
      expect(childBrief).toContain("check add");
      expect(childBrief).toContain("## Live review target");
      expect(childBrief).toContain("Paths: math.js");
      expect(childBrief).toContain("## Review boundaries");
      expect(childResultSchema).toMatchObject({
        required: expect.arrayContaining(["type", "findings", "emptyDiff"]),
      });
      expect(JSON.parse(childToolResults[0]!)).toMatchObject({
        error:
          "Background completion requires a valid review_findings result in set_task_status.result",
        issues: [{ path: "result.emptyDiff" }],
      });
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("asks a child without set_task_status to print its envelope, and fails one that does not", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-printed-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    const briefs: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const messages = body.messages ?? [];
      const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (firstUser.startsWith("make a patch")) {
        briefs.push(firstUser);
        return completion(
          'Done.\n\n```json\n{"type":"patch","summary":"Added notes","files":["notes.md"]}\n```',
        );
      }
      if (firstUser.startsWith("verify it")) {
        return completion("It looks fine to me.");
      }
      if (!hasToolResult) {
        return toolCall("spawn_background_agent", {
          task: firstUser === "delegate patch" ? "Patch" : "Verify",
          message:
            firstUser === "delegate patch" ? "make a patch" : "verify it",
          expectedResult:
            firstUser === "delegate patch" ? "patch" : "verification",
        });
      }
      return completion("parent done");
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-printed",
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
      const patch = await host.createSession();
      await host.runTurn(patch.sessionId, "delegate patch");
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(patch.sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          structuredResult: {
            type: "patch",
            summary: "Added notes",
            files: ["notes.md"],
          },
          resultText: "Added notes\n\n**Files**\n- `notes.md`",
        });
      });
      expect(briefs[0]).toBe(
        withFleetResultInstruction("patch", "make a patch"),
      );

      const verify = await host.createSession();
      await host.runTurn(verify.sessionId, "delegate verify");
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(verify.sessionId)[0]).toMatchObject({
          lifecycle: "failed",
          resultState: "incomplete_expected_result",
          terminalReason: "incomplete_expected_result",
          partialOutput: "It looks fine to me.",
        });
      });
      const failed = host.listBackgroundAgents(verify.sessionId)[0]!;
      expect(failed.expectedResultIssue).toContain(
        'Expected a "verification" envelope; the final message parsed as plain text without a valid envelope.',
      );
      expect(
        JSON.parse(workspaceBackgroundOutcome(failed).result),
      ).toMatchObject({
        status: "incomplete_expected_result",
        terminalReason: "incomplete_expected_result",
        retrySafe: true,
        agentRetryable: false,
        expectedResultIssue: failed.expectedResultIssue,
        partialOutput: "It looks fine to me.",
      });
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives a review task class VS Code's read-only review defaults", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-taskclass-"),
    );
    const events = backgroundEvents();
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "math.js"), "export {};\n");
    const parentResults: string[] = [];
    const reviewer: { tools: string[]; results: string[] } = {
      tools: [],
      results: [],
    };
    const parentFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = requestBody(init);
      const results = body.toolResults;
      parentResults.splice(0, Infinity, ...results);
      if (body.firstUser.includes("owned review") && results.length === 0) {
        return toolCall("spawn_background_agent", {
          task: "Review",
          message: "REVIEWER-TASK",
          taskClass: "review_code",
          ownedPaths: ["math.js"],
        });
      }
      if (body.firstUser.includes("plain review") && results.length === 0) {
        return toolCall("spawn_background_agent", {
          task: "Review",
          message: "REVIEWER-TASK",
          taskClass: " Review_Code ",
        });
      }
      return completion("parent done");
    });
    const reviewFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = requestBody(init);
      reviewer.tools = body.tools;
      reviewer.results.splice(0, Infinity, ...body.toolResults);
      if (body.toolResults.length === 0) {
        return numberedToolCall("execute_command", {
          command: "touch out.txt",
        });
      }
      return numberedToolCall("set_task_status", {
        status: "completed",
        result: { type: "review_findings", findings: [], emptyDiff: false },
      });
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-taskclass",
      providers: [
        fixtureProvider("fixture", "fixture-model", parentFetch),
        fixtureProvider("claude", "review-model", reviewFetch),
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
      modes: { enabled: true },
      sessionInteractions: { finalStatus: true },
      commands: {
        enabled: true,
        shellExecutable: "/bin/sh",
        resolveEnvironment: () => ({ PATH: process.env.PATH }),
        // Allow everything: the review child's read-only policy must decide.
        hasSessionGrant: () => true,
      },
      background: {
        enabled: true,
        ...events.callbacks,
        inheritSessionGrants: true,
        modelRoles: {
          review: { providerId: "claude", modelId: "review-model" },
        },
      },
    });
    try {
      // A review child is read-only: owned paths are refused.
      const owned = await host.createSession();
      await host.runTurn(owned.sessionId, "owned review");
      expect(parentResults[0]).toContain("background_task_class_is_read_only");
      expect(host.listBackgroundAgents(owned.sessionId)).toEqual([]);

      const { sessionId } = await host.createSession();
      await host.runTurn(sessionId, "plain review");
      expect(JSON.parse(parentResults[0]!)).toMatchObject({
        resolvedMode: "review",
        resolvedModel: "review-model",
        resolvedProvider: "claude",
        taskClass: "review_code",
        routingReason: "taskClass review_code: model_role review",
        fallbackUsed: false,
        expectedResult: "review_findings",
      });
      await events.settled;
      expect(host.listBackgroundAgents(sessionId)[0]).toMatchObject({
        lifecycle: "completed",
        taskClass: "review_code",
        resolvedMode: "review",
        expectedResult: "review_findings",
        structuredResult: { type: "review_findings", emptyDiff: false },
      });
      // Its command was not cleared by VS Code's read-only check, so it was
      // refused outright, as VS Code's review profile does, despite the
      // parent's grant: no approval card, and nothing ran.
      expect(reviewer.tools).toContain("execute_command");
      expect(reviewer.results[0]).toContain("readonly_policy_rejected");
      expect(host.listBackgroundApprovals(sessionId)).toEqual([]);
      await expect(
        fs.stat(path.join(projectRoot, "out.txt")),
      ).rejects.toThrow();
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("maps modelTier onto configured model roles, falling back to the parent's model", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-tier-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    const parentResults: string[] = [];
    const parentFetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = requestBody(init);
      if (body.firstUser.includes("CHILD")) return completion("child done");
      parentResults.splice(0, Infinity, ...body.toolResults);
      const spawn = body.rawTools.find(
        (tool) => tool.function?.name === "spawn_background_agent",
      );
      expect(spawn?.function?.parameters?.properties).toMatchObject({
        modelTier: {
          enum: ["cheap", "balanced", "deep_reasoning", "foreground"],
        },
        budget: { type: "object" },
        taskClass: { type: "string" },
      });
      const tier = body.firstUser.includes("balanced") ? "balanced" : "cheap";
      if (body.toolResults.length === 0) {
        return toolCall("spawn_background_agent", {
          task: tier,
          message: `CHILD ${tier}`,
          modelTier: tier,
        });
      }
      return completion("parent done");
    });
    const tierFetch = vi.fn<typeof globalThis.fetch>(async () =>
      completion("tier child done"),
    );
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-tier",
      providers: [
        fixtureProvider("fixture", "fixture-model", parentFetch),
        fixtureProvider("tier", "balanced-model", tierFetch),
      ],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
      background: {
        enabled: true,
        modelRoles: {
          balanced: { providerId: "tier", modelId: "balanced-model" },
        },
      },
    });
    try {
      const balanced = await host.createSession();
      await host.runTurn(balanced.sessionId, "spawn balanced");
      expect(JSON.parse(parentResults[0]!)).toMatchObject({
        resolvedModel: "balanced-model",
        requestedModelTier: "balanced",
        modelTier: "balanced",
        routingReason: "modelTier balanced: model_role balanced",
        fallbackUsed: false,
      });
      const cheap = await host.createSession();
      await host.runTurn(cheap.sessionId, "spawn cheap");
      // The parent's model: here the host default, which is not reported.
      expect(JSON.parse(parentResults[0]!)).not.toHaveProperty("resolvedModel");
      expect(JSON.parse(parentResults[0]!)).toMatchObject({
        requestedModelTier: "cheap",
        routingReason:
          "no model role is configured for modelTier cheap; parent session model",
        fallbackUsed: true,
      });
      expect(JSON.parse(parentResults[0]!)).not.toHaveProperty("modelTier");
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(cheap.sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultText: "child done",
          taskClass: "general",
          requestedModelTier: "cheap",
          fallbackUsed: true,
        });
      });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(balanced.sessionId)[0]).toMatchObject({
          lifecycle: "completed",
          resultText: "tier child done",
        });
      });
      // Only the balanced child ran on the tier model.
      expect(tierFetch).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("stops a child at VS Code's hard API-turn and elapsed-time budget limits", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "workspace-background-budget-"),
    );
    const projectRoot = path.join(root, "project");
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "notes.txt"), "notes\n");
    const parentResults: string[] = [];
    let turnsChildCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = requestBody(init);
      if (body.firstUser.includes("LOOP")) {
        turnsChildCalls += 1;
        // Never finishes on its own.
        return numberedToolCall("read_file", { path: "notes.txt" });
      }
      if (body.firstUser.includes("HANG")) {
        // Waits until the run is stopped.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      parentResults.splice(0, Infinity, ...body.toolResults);
      if (body.toolResults.length > 0) return completion("parent done");
      return body.firstUser.includes("turns")
        ? toolCall("spawn_background_agent", {
            task: "loop",
            message: "LOOP",
            budget: { maxApiTurns: 1, maxTokens: 10 },
          })
        : toolCall("spawn_background_agent", {
            task: "hang",
            message: "HANG",
            taskClass: "review_code",
            budget: { maxElapsedMs: 40 },
          });
    });
    const host = await createWorkspaceHost({
      projectRoot,
      dataRoot: path.join(root, "data"),
      ownerId: "background-budget",
      providers: [fixtureProvider("fixture", "fixture-model", fetch)],
      defaultModel: { providerId: "fixture", modelId: "fixture-model" },
      files: { enabled: true },
      background: { enabled: true },
    });
    try {
      const turns = await host.createSession();
      await host.runTurn(turns.sessionId, "spawn turns");
      expect(JSON.parse(parentResults[0]!)).toMatchObject({
        budget: { maxApiTurns: 1, maxTokens: 10, scope: "session" },
        budgetNotEnforced: ["maxTokens"],
      });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(turns.sessionId)[0]).toMatchObject({
          lifecycle: "failed",
          resultState: "budget_exhausted",
          terminalReason: "budget_exhausted:api_turns",
          // ceil(1 × 3) successful model turns, then the next is refused.
          budgetUsage: { apiTurns: 3, toolCalls: 3 },
        });
      });
      expect(turnsChildCalls).toBeLessThanOrEqual(4);
      const exhausted = host.listBackgroundAgents(turns.sessionId)[0]!;
      expect(
        JSON.parse(workspaceBackgroundOutcome(exhausted).result),
      ).toMatchObject({
        status: "budget_exhausted",
        terminalReason: "budget_exhausted:api_turns",
      });

      const elapsed = await host.createSession();
      await host.runTurn(elapsed.sessionId, "spawn elapsed");
      // A review keeps only work-unit and time limits, at 1.5×.
      expect(JSON.parse(parentResults[0]!)).toMatchObject({
        taskClass: "review_code",
        budget: { maxElapsedMs: 40 },
      });
      await vi.waitFor(() => {
        expect(host.listBackgroundAgents(elapsed.sessionId)[0]).toMatchObject({
          lifecycle: "failed",
          resultState: "budget_exhausted",
          terminalReason: "budget_exhausted:elapsed_time",
        });
      });
      const timed = host.listBackgroundAgents(elapsed.sessionId)[0]!;
      expect(timed.budgetUsage!.elapsedMs).toBeGreaterThanOrEqual(60);
    } finally {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

let numberedCalls = 0;

/** A tool call with a fresh call ID, for children that call repeatedly. */
function numberedToolCall(
  name: string,
  input: Record<string, unknown>,
): Response {
  numberedCalls += 1;
  const response = toolCall(name, input);
  return new Response(
    response.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(
            new TextEncoder().encode(
              new TextDecoder()
                .decode(chunk)
                .replaceAll(`call-${name}`, `call-${name}-${numberedCalls}`),
            ),
          );
        },
      }),
    ),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function requestBody(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body)) as {
    messages?: Array<{ role?: string; content?: unknown }>;
    tools?: Array<{
      function?: {
        name?: string;
        parameters?: { properties?: Record<string, unknown> };
      };
    }>;
  };
  const messages = body.messages ?? [];
  const firstUser = messages.find((m) => m.role === "user")?.content;
  return {
    firstUser:
      typeof firstUser === "string" ? firstUser : JSON.stringify(firstUser),
    toolResults: messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.content)),
    tools:
      body.tools?.flatMap((tool) =>
        tool.function?.name ? [tool.function.name] : [],
      ) ?? [],
    rawTools: body.tools ?? [],
  };
}

function fixtureProvider(
  id: string,
  modelId: string,
  fetch: typeof globalThis.fetch,
) {
  return {
    type: "openai-compatible" as const,
    id,
    baseURL: `https://${id}.invalid/v1`,
    noAuth: true as const,
    models: [
      {
        id: modelId,
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        supportsToolUse: true,
      },
    ],
    fetch,
  };
}
