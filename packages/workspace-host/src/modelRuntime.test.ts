import { describe, expect, it, vi } from "vitest";

import { createWorkspaceModelRuntime } from "./modelRuntime.js";

const principal = { tenantId: "local", subjectId: "project" };
const model = { providerId: "compatible", modelId: "test-model" };

describe("createWorkspaceModelRuntime", () => {
  it.each(["complete", "stream"] as const)(
    "checks the %s request envelope immediately before provider dispatch",
    async (operation) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const runtime = createWorkspaceModelRuntime({
        ownerId: "test",
        providers: [
          {
            type: "openai-compatible",
            id: "compatible",
            baseURL: "https://example.invalid/v1",
            noAuth: true,
            models: [
              {
                id: "test-model",
                contextWindow: 100,
                maxOutputTokens: 20,
                supportsToolUse: false,
              },
            ],
            fetch,
          },
        ],
        limits: { inputSafetyTokens: 10 },
      });

      const request = {
        principal,
        authContext: undefined,
        model,
        request: {
          systemPrompt: "x".repeat(100),
          messages: [{ role: "user" as const, content: "hello" }],
          maxTokens: 20,
        },
      };
      if (operation === "complete") {
        await expect(runtime.complete(request)).rejects.toMatchObject({
          code: "workspace_context_limit_exceeded",
        });
      } else {
        await expect(runtime.stream(request).next()).rejects.toMatchObject({
          code: "workspace_context_limit_exceeded",
        });
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
