import type {
  DesktopMode,
  DesktopRemoteState,
} from "../../shared/desktopBridge";
import { useEffect, useRef, useState } from "preact/hooks";

export function DesktopRemotePane({ mode }: { mode: DesktopMode }) {
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
    <div ref={element} class="desktop-remote-pane" hidden={mode !== "vscode"}>
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
    </div>
  );
}
