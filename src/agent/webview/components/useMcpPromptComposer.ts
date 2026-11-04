import { useEffect, useRef, useState } from "preact/hooks";

import type { ChatMcpPromptInvocation } from "@agentlink/protocol/chat-catalog";
import { randomId } from "../../../shared/randomId.js";

/** Request/reply transport shared by VS Code and the browser composer shim. */
export function useMcpPromptComposer(
  postMessage: (message: unknown) => void,
  sessionId?: string | null,
) {
  const [pending, setPending] = useState(false);
  const requests = useRef(
    new Map<string, (reply: Record<string, unknown>) => void>(),
  );
  const owner = useRef(sessionId);
  owner.current = sessionId;
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const reply = event.data;
      if (
        !reply ||
        (reply.type !== "agentMcpPromptPrepared" &&
          reply.type !== "agentMcpPromptCompletions")
      )
        return;
      const resolve = requests.current.get(reply.requestId);
      if (!resolve) return;
      requests.current.delete(reply.requestId);
      resolve(reply);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      for (const resolve of requests.current.values())
        resolve({ ok: false, error: "Cancelled" });
      requests.current.clear();
    };
  }, []);
  useEffect(() => {
    for (const resolve of requests.current.values())
      resolve({ ok: false, error: "Chat changed" });
    requests.current.clear();
    setPending(false);
  }, [sessionId]);

  function request(
    command: string,
    payload: Record<string, unknown>,
    timeout: number,
  ) {
    const requestId = randomId();
    return new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        requests.current.get(requestId)?.({
          ok: false,
          error: "MCP prompt request timed out.",
        });
        requests.current.delete(requestId);
      }, timeout);
      requests.current.set(requestId, (reply) => {
        clearTimeout(timer);
        if (command === "agentPrepareMcpPrompt" && !reply.type) {
          postMessage({
            command: "agentCancelMcpPrompt",
            requestId,
            sessionId,
          });
        }
        resolve(reply);
      });
      postMessage({ command, requestId, sessionId, ...payload });
    });
  }
  return {
    pending,
    async prepare(
      invocation: ChatMcpPromptInvocation,
    ): Promise<{ text?: string; error?: string }> {
      if (pending) return {};
      const session = sessionId;
      setPending(true);
      try {
        const reply = await request(
          "agentPrepareMcpPrompt",
          { invocation },
          10 * 60_000,
        );
        if (owner.current !== session) return {};
        return reply.ok === true && typeof reply.text === "string"
          ? { text: reply.text }
          : {
              error:
                typeof reply.error === "string"
                  ? reply.error
                  : "Nothing was sent.",
            };
      } finally {
        if (owner.current === session) setPending(false);
      }
    },
    async complete(
      invocation: ChatMcpPromptInvocation,
      argumentName: string,
      value: string,
    ): Promise<string[]> {
      const reply = await request(
        "agentCompleteMcpPrompt",
        {
          request: { ...invocation, argumentName, value },
        },
        6_000,
      );
      return Array.isArray(reply.values)
        ? reply.values.filter((v): v is string => typeof v === "string")
        : [];
    },
  };
}
