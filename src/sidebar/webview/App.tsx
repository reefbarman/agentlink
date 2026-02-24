import { useReducer, useEffect } from "preact/hooks";
import type { SidebarState, TrackedCallInfo, ExtensionMessage, PostCommand } from "./types.js";
import { ActiveToolCalls } from "./components/ActiveToolCalls.js";
import { ServerStatus } from "./components/ServerStatus.js";
import { ClaudeIntegration } from "./components/ClaudeIntegration.js";
import { WriteApproval } from "./components/WriteApproval.js";
import { TrustedPaths } from "./components/TrustedPaths.js";
import { TrustedCommands } from "./components/TrustedCommands.js";
import { AvailableTools } from "./components/AvailableTools.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

interface State {
  sidebar: SidebarState;
  toolCalls: TrackedCallInfo[];
}

type Action =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] };

const initialState: State = {
  sidebar: {
    serverRunning: false,
    port: null,
    sessions: 0,
    authEnabled: true,
    claudeConfigured: false,
    masterBypass: false,
  },
  toolCalls: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "stateUpdate":
      return { ...state, sidebar: action.state };
    case "updateToolCalls":
      return { ...state, toolCalls: action.calls };
    default:
      return state;
  }
}

export function App({ vscodeApi }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const postCommand: PostCommand = (command, data) => {
    vscodeApi.postMessage({ command, ...data });
  };

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (msg.type === "stateUpdate" || msg.type === "updateToolCalls") {
        dispatch(msg);
      }
    };
    window.addEventListener("message", handler);
    // Tell extension we're ready to receive state
    vscodeApi.postMessage({ command: "webviewReady" });
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <div>
      <ActiveToolCalls calls={state.toolCalls} postCommand={postCommand} />
      <ServerStatus state={state.sidebar} postCommand={postCommand} />
      <ClaudeIntegration state={state.sidebar} postCommand={postCommand} />
      <WriteApproval state={state.sidebar} postCommand={postCommand} />
      <TrustedPaths state={state.sidebar} postCommand={postCommand} />
      <TrustedCommands state={state.sidebar} postCommand={postCommand} />
      <AvailableTools />
    </div>
  );
}
