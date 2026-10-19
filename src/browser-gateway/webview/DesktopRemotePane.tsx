import type {
  DesktopAssistantState,
  DesktopMode,
  DesktopRemoteState,
} from "../../shared/desktopBridge";
import { useEffect, useRef, useState } from "preact/hooks";

/**
 * The area native desktop views (VS Code workspaces, the Assistant) are laid
 * over. It reports its bounds and shows a placeholder while the view is not
 * ready.
 */
export function DesktopRemotePane({
  mode,
  assistant,
}: {
  mode: DesktopMode;
  /** The embedded Assistant's state, owned by the app (one subscription). */
  assistant: DesktopAssistantState | null;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<DesktopRemoteState>({ status: "idle" });

  useEffect(() => window.agentlinkDesktopShell?.onRemoteState(setState), []);
  useEffect(() => {
    const bridge = window.agentlinkDesktopShell;
    const pane = element.current;
    if (!bridge || !pane) return;
    const report = () => {
      const rect = pane.getBoundingClientRect();
      bridge.setRemoteLayout({
        mode,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(pane);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      bridge.setRemoteLayout({
        mode: "ask",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      });
    };
  }, [mode]);

  return (
    <div ref={element} class="desktop-remote-pane" hidden={mode === "ask"}>
      {mode === "assistant" ? (
        <AssistantPlaceholder state={assistant} />
      ) : (
        <div class="desktop-remote-placeholder" role="status">
          <i class="codicon codicon-vscode" aria-hidden="true" />
          <h2>
            {state.status === "connecting"
              ? "Connecting to VS Code…"
              : "Your VS Code workspaces"}
          </h2>
          <p>
            {state.status === "ready"
              ? "Connected to the local VS Code gateway."
              : "Open VS Code with AgentLink to connect. Your workspace tabs will appear here."}
          </p>
          <button
            type="button"
            onClick={() => window.agentlinkDesktopShell?.retryRemote()}
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantPlaceholder({
  state,
}: {
  state: DesktopAssistantState | null;
}) {
  const where = state ? ` at ${state.origin}` : "";
  let message = "Your self-hosted Assistant appears here.";
  if (state?.status === "connecting") {
    message = `Connecting${where}…`;
  } else if (state?.status === "unavailable") {
    message =
      state.error === "certificate"
        ? state.pinned
          ? `The Assistant${where} presented a certificate its pinned CA did not issue. Check the address and the CA in Settings.`
          : `This Mac does not trust the Assistant's certificate${where}. Add its CA in Settings (export it with agentlink-server export-ca).`
        : `Could not reach the Assistant${where}. Check it is running and the address in Settings.`;
  }
  return (
    <div class="desktop-remote-placeholder" role="status">
      <i class="codicon codicon-sparkle" aria-hidden="true" />
      <h2>
        {state?.status === "connecting"
          ? "Connecting to your Assistant…"
          : "AgentLink Assistant"}
      </h2>
      <p>{message}</p>
      <div class="desktop-remote-actions">
        <button
          type="button"
          onClick={() => window.agentlinkDesktopShell?.retryAssistant?.()}
        >
          Reconnect
        </button>
        {window.agentlinkDesktopShell?.openSettings && (
          <button
            type="button"
            onClick={() => window.agentlinkDesktopShell?.openSettings?.()}
          >
            Settings
          </button>
        )}
      </div>
    </div>
  );
}
