import { useState, useEffect, useCallback } from "preact/hooks";
import type { ApprovalRequest, ExtensionMessage, DecisionMessage } from "./types.js";
import { CommandCard } from "./components/CommandCard.js";
import { PathCard } from "./components/PathCard.js";
import { WriteCard } from "./components/WriteCard.js";
import { IdleState } from "./components/IdleState.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

export function App({ vscodeApi }: AppProps) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  const submit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      vscodeApi.postMessage({ type: "decision", ...data });
    },
    [vscodeApi],
  );

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (msg.type === "showApproval") {
        setRequest(msg.request);
      } else if (msg.type === "idle") {
        setRequest(null);
      }
    };
    window.addEventListener("message", handler);
    vscodeApi.postMessage({ type: "webviewReady" });
    return () => window.removeEventListener("message", handler);
  }, [vscodeApi]);

  if (!request) return <IdleState />;

  switch (request.kind) {
    case "command":
      return <CommandCard request={request} submit={submit} />;
    case "path":
      return <PathCard request={request} submit={submit} />;
    case "write":
      return <WriteCard request={request} submit={submit} />;
  }
}
