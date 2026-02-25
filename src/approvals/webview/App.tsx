import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type {
  ApprovalRequest,
  ExtensionMessage,
  DecisionMessage,
} from "./types.js";
import { CommandCard } from "./components/CommandCard.js";
import { PathCard } from "./components/PathCard.js";
import { WriteCard } from "./components/WriteCard.js";
import { RenameCard } from "./components/RenameCard.js";
import { IdleState } from "./components/IdleState.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

export function App({ vscodeApi }: AppProps) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const followUpRef = useRef("");

  const submit = useCallback(
    (data: Omit<DecisionMessage, "type">) => {
      const followUp = followUpRef.current.trim();
      vscodeApi.postMessage({
        type: "decision",
        ...data,
        ...(followUp && { followUp }),
      });
      followUpRef.current = "";
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
      return (
        <CommandCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "path":
      return (
        <PathCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "write":
      return (
        <WriteCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
    case "rename":
      return (
        <RenameCard
          request={request}
          submit={submit}
          followUpRef={followUpRef}
        />
      );
  }
}
