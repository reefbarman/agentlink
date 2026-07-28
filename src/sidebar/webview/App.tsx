import type {
  ExtensionMessage,
  FeedbackEntry,
  IndexStatusInfo,
  PostCommand,
  SidebarState,
  TrackedCallInfo,
} from "./types.js";
import { useEffect, useReducer } from "preact/hooks";

import { ActiveToolCalls } from "./components/ActiveToolCalls.js";
import { ActivityShortcuts } from "./components/ActivityShortcuts.js";
import { ContextHealthPanel } from "../../shared/ui/ContextHealthPanel.js";
import { FeedbackList } from "./components/FeedbackList.js";
import { IndexStatus } from "./components/IndexStatus.js";
import { TrustedCommands } from "./components/TrustedCommands.js";
import { TrustedPaths } from "./components/TrustedPaths.js";
import { WriteApproval } from "./components/WriteApproval.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): T;
}

interface AppProps {
  vscodeApi: VsCodeApi;
}

interface State {
  sidebar: SidebarState;
  toolCalls: TrackedCallInfo[];
  feedbackEntries: FeedbackEntry[];
}

type Action =
  | { type: "stateUpdate"; state: SidebarState }
  | { type: "updateToolCalls"; calls: TrackedCallInfo[] }
  | { type: "updateFeedback"; entries: FeedbackEntry[] }
  | {
      type: "updateContextHealth";
      health: NonNullable<SidebarState["contextHealth"]>;
    }
  | { type: "updateIndexStatus"; status: IndexStatusInfo };

const initialState: State = {
  sidebar: {
    masterBypass: false,
    hasWorkspace: false,
  },
  toolCalls: [],
  feedbackEntries: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "stateUpdate":
      return { ...state, sidebar: action.state };
    case "updateToolCalls":
      return { ...state, toolCalls: action.calls };
    case "updateFeedback":
      return { ...state, feedbackEntries: action.entries };
    case "updateContextHealth":
      return {
        ...state,
        sidebar: { ...state.sidebar, contextHealth: action.health },
      };
    case "updateIndexStatus":
      return {
        ...state,
        sidebar: { ...state.sidebar, indexStatus: action.status },
      };
    default:
      return state;
  }
}

export function App({ vscodeApi }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const postCommand = ((command: string, data?: object) => {
    vscodeApi.postMessage({ command, ...data });
  }) as PostCommand;

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      if (
        msg.type === "stateUpdate" ||
        msg.type === "updateToolCalls" ||
        msg.type === "updateFeedback" ||
        msg.type === "updateContextHealth" ||
        msg.type === "updateIndexStatus"
      ) {
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
      {state.sidebar.contextHealth && (
        <ContextHealthPanel health={state.sidebar.contextHealth} />
      )}
      <IndexStatus state={state.sidebar} postCommand={postCommand} />
      <WriteApproval state={state.sidebar} postCommand={postCommand} />
      <TrustedPaths state={state.sidebar} postCommand={postCommand} />
      <TrustedCommands state={state.sidebar} postCommand={postCommand} />
      <ActivityShortcuts postCommand={postCommand} />
      {__DEV_BUILD__ && (
        <FeedbackList
          entries={state.feedbackEntries}
          postCommand={postCommand}
        />
      )}
    </div>
  );
}
