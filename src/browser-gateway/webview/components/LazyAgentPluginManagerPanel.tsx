import type {
  AgentPluginManagerPanel,
  AgentPluginManagerPanelProps,
} from "../../../shared/ui/AgentPluginManagerPanel";
import { useEffect, useState } from "preact/hooks";

let panelModulePromise:
  | Promise<typeof import("../../../shared/ui/AgentPluginManagerPanel")>
  | undefined;

function loadPanelModule() {
  panelModulePromise ??=
    import("../../../shared/ui/AgentPluginManagerPanel").catch(
      (error: unknown) => {
        panelModulePromise = undefined;
        throw error;
      },
    );
  return panelModulePromise;
}

type PanelComponent = typeof AgentPluginManagerPanel;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; Panel: PanelComponent }
  | { kind: "error"; message: string };

export function LazyAgentPluginManagerPanel(
  props: AgentPluginManagerPanelProps,
) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let disposed = false;
    setState({ kind: "loading" });
    void loadPanelModule()
      .then(({ AgentPluginManagerPanel: Panel }) => {
        if (!disposed) setState({ kind: "ready", Panel });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message =
          error instanceof Error ? error.message : "unknown chunk load error";
        setState({ kind: "error", message });
      });
    return () => {
      disposed = true;
    };
  }, [loadAttempt]);

  if (state.kind === "ready") return <state.Panel {...props} />;
  if (state.kind === "error") {
    return (
      <div class="pane-card browser-lazy-panel-state" role="alert">
        <p>Agent Plugin management failed to load: {state.message}</p>
        <div class="pane-actions">
          <button
            type="button"
            onClick={() => setLoadAttempt((value) => value + 1)}
          >
            Retry
          </button>
          {props.onClose && (
            <button type="button" class="secondary" onClick={props.onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div class="pane-card browser-lazy-panel-state" role="status">
      Loading Agent Plugin management…
    </div>
  );
}
