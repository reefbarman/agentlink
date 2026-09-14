import type { StandaloneSessionProjection } from "../sessionProjection.js";

export type TuiFocus = "transcript" | "activity" | "composer";
export type TuiPickerKind = "commands" | "files";

export interface TuiPickerItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly insertText: string;
}

export interface TuiShellState {
  readonly focus: TuiFocus;
  readonly composer: string;
  readonly history: readonly string[];
  readonly historyIndex?: number;
  readonly historyDraft: string;
  readonly transcriptOffset: number;
  readonly followOutput: boolean;
  readonly activitySelectedIndex: number;
  readonly expandedActivityIds: readonly string[];
  readonly expandedToolTurnIds: readonly string[];
  readonly picker?: {
    readonly kind: TuiPickerKind;
    readonly query: string;
    readonly selectedIndex: number;
    readonly items: readonly TuiPickerItem[];
  };
  readonly status?: string;
}

export type TuiShellAction =
  | { readonly type: "composer.changed"; readonly value: string }
  | { readonly type: "composer.submitted"; readonly value: string }
  | { readonly type: "composer.replaced"; readonly value: string }
  | { readonly type: "focus.changed"; readonly focus: TuiFocus }
  | { readonly type: "history.previous" }
  | { readonly type: "history.next" }
  | { readonly type: "session.changed" }
  | {
      readonly type: "activity.moved";
      readonly offset: -1 | 1;
      readonly itemCount: number;
    }
  | { readonly type: "activity.first" }
  | { readonly type: "activity.last"; readonly itemCount: number }
  | {
      readonly type: "activity.toggled";
      readonly itemId: string;
      readonly itemIndex?: number;
    }
  | { readonly type: "tool_group.toggled"; readonly turnId: string }
  | { readonly type: "picker.closed" }
  | { readonly type: "picker.moved"; readonly offset: -1 | 1 }
  | { readonly type: "picker.opened"; readonly kind: TuiPickerKind }
  | {
      readonly type: "picker.refreshed";
      readonly items: readonly TuiPickerItem[];
    }
  | {
      readonly type: "scroll.by";
      readonly rows: number;
      readonly maxOffset: number;
    }
  | { readonly type: "scroll.bottom" }
  | { readonly type: "scroll.top"; readonly maxOffset: number }
  | { readonly type: "status.changed"; readonly status?: string };

export const TUI_COMMANDS: readonly TuiPickerItem[] = [
  {
    id: "/new",
    label: "/new",
    detail: "Start a new session",
    insertText: "/new",
  },
  {
    id: "/model",
    label: "/model",
    detail: "Choose the session model",
    insertText: "/model",
  },
  {
    id: "/reasoning",
    label: "/reasoning",
    detail: "Choose reasoning effort",
    insertText: "/reasoning",
  },
  {
    id: "/mode",
    label: "/mode",
    detail: "Show standalone mode availability",
    insertText: "/mode",
  },
  {
    id: "/sessions",
    label: "/sessions",
    detail: "List project sessions",
    insertText: "/sessions",
  },
  {
    id: "/processes",
    label: "/processes",
    detail: "List retained commands",
    insertText: "/processes",
  },
  {
    id: "/agents",
    label: "/agents",
    detail: "List background agents",
    insertText: "/agents",
  },
  {
    id: "/approvals",
    label: "/approvals",
    detail: "Review background approvals",
    insertText: "/approvals",
  },
  {
    id: "/help",
    label: "/help",
    detail: "Show TUI shortcuts",
    insertText: "/help",
  },
  {
    id: "/exit",
    label: "/exit",
    detail: "Exit AgentLink",
    insertText: "/exit",
  },
];

export function initialTuiShellState(): TuiShellState {
  return {
    focus: "composer",
    composer: "",
    history: [],
    historyDraft: "",
    transcriptOffset: 0,
    followOutput: true,
    activitySelectedIndex: 0,
    expandedActivityIds: [],
    expandedToolTurnIds: [],
  };
}

export function reduceTuiShellState(
  state: TuiShellState,
  action: TuiShellAction,
): TuiShellState {
  switch (action.type) {
    case "composer.changed": {
      const picker = pickerForValue(action.value, state.picker);
      return {
        ...state,
        composer: action.value,
        historyIndex: undefined,
        historyDraft: action.value,
        picker,
      };
    }
    case "composer.replaced":
      return {
        ...state,
        composer: action.value,
        picker: undefined,
        historyIndex: undefined,
        historyDraft: action.value,
      };
    case "composer.submitted": {
      const value = action.value.trim();
      if (!value) return { ...state, composer: "", picker: undefined };
      return {
        ...state,
        composer: "",
        history: [
          ...state.history.filter((entry) => entry !== value),
          value,
        ].slice(-100),
        historyIndex: undefined,
        historyDraft: "",
        picker: undefined,
        followOutput: true,
        transcriptOffset: 0,
      };
    }
    case "focus.changed":
      return { ...state, focus: action.focus, picker: undefined };
    case "history.previous": {
      if (state.history.length === 0) return state;
      const historyIndex = Math.max(
        0,
        state.historyIndex === undefined
          ? state.history.length - 1
          : state.historyIndex - 1,
      );
      return {
        ...state,
        historyIndex,
        composer: state.history[historyIndex] ?? "",
      };
    }
    case "history.next": {
      if (state.historyIndex === undefined) return state;
      const historyIndex = state.historyIndex + 1;
      if (historyIndex >= state.history.length) {
        return {
          ...state,
          historyIndex: undefined,
          composer: state.historyDraft,
        };
      }
      return {
        ...state,
        historyIndex,
        composer: state.history[historyIndex] ?? "",
      };
    }
    case "session.changed":
      return {
        ...state,
        transcriptOffset: 0,
        followOutput: true,
        activitySelectedIndex: 0,
        expandedActivityIds: [],
        expandedToolTurnIds: [],
      };
    case "activity.moved": {
      if (action.itemCount <= 0) return state;
      return {
        ...state,
        activitySelectedIndex:
          (state.activitySelectedIndex + action.offset + action.itemCount) %
          action.itemCount,
        expandedActivityIds: [],
      };
    }
    case "activity.first":
      return { ...state, activitySelectedIndex: 0, expandedActivityIds: [] };
    case "activity.last":
      return {
        ...state,
        activitySelectedIndex: Math.max(0, action.itemCount - 1),
        expandedActivityIds: [],
      };
    case "activity.toggled":
      return {
        ...state,
        activitySelectedIndex: action.itemIndex ?? state.activitySelectedIndex,
        expandedActivityIds: state.expandedActivityIds.includes(action.itemId)
          ? []
          : [action.itemId],
      };
    case "tool_group.toggled":
      return {
        ...state,
        expandedToolTurnIds: state.expandedToolTurnIds.includes(action.turnId)
          ? state.expandedToolTurnIds.filter(
              (turnId) => turnId !== action.turnId,
            )
          : [...state.expandedToolTurnIds, action.turnId],
      };
    case "picker.closed":
      return { ...state, picker: undefined };
    case "picker.moved": {
      if (!state.picker || state.picker.items.length === 0) return state;
      const length = state.picker.items.length;
      return {
        ...state,
        picker: {
          ...state.picker,
          selectedIndex:
            (state.picker.selectedIndex + action.offset + length) % length,
        },
      };
    }
    case "picker.opened":
      return {
        ...state,
        picker: {
          kind: action.kind,
          query: "",
          selectedIndex: 0,
          items: action.kind === "commands" ? TUI_COMMANDS : [],
        },
      };
    case "picker.refreshed":
      return state.picker
        ? {
            ...state,
            picker: {
              ...state.picker,
              items: action.items,
              selectedIndex: Math.min(
                state.picker.selectedIndex,
                Math.max(0, action.items.length - 1),
              ),
            },
          }
        : state;
    case "scroll.by": {
      const transcriptOffset = Math.min(
        Math.max(0, action.maxOffset),
        Math.max(0, state.transcriptOffset + action.rows),
      );
      return {
        ...state,
        transcriptOffset,
        followOutput: transcriptOffset <= 0,
      };
    }
    case "scroll.bottom":
      return { ...state, transcriptOffset: 0, followOutput: true };
    case "scroll.top":
      return {
        ...state,
        transcriptOffset: Math.max(0, action.maxOffset),
        followOutput: action.maxOffset <= 0,
      };
    case "status.changed":
      return { ...state, status: action.status };
  }
}

export interface VisibleTranscriptItem {
  readonly message: StandaloneSessionProjection["transcript"][number];
  readonly contentOffsetRows: number;
  readonly visibleRows: number;
}

export function visibleTranscriptWindow(
  projection: StandaloneSessionProjection,
  state: TuiShellState,
  viewportRows: number,
  contentWidth = 80,
): readonly VisibleTranscriptItem[] {
  const messages = projection.transcript;
  if (messages.length === 0) return [];
  const rowBudget = Math.max(1, viewportRows);
  const heights = messages.map((message) =>
    transcriptItemRows(
      projection,
      message,
      contentWidth,
      state.expandedToolTurnIds,
    ),
  );
  const totalRows = heights.reduce((total, height) => total + height, 0);
  const maxOffset = Math.max(0, totalRows - rowBudget);
  const offset = Math.min(maxOffset, Math.max(0, state.transcriptOffset));
  const windowEnd = totalRows - offset;
  const windowStart = Math.max(0, windowEnd - rowBudget);
  const visible: VisibleTranscriptItem[] = [];
  let itemStart = 0;
  for (const [index, message] of messages.entries()) {
    const height = heights[index] ?? 1;
    const itemEnd = itemStart + height;
    if (itemEnd > windowStart && itemStart < windowEnd) {
      const visibleStart = Math.max(0, windowStart - itemStart);
      const visibleEnd = Math.min(height, windowEnd - itemStart);
      visible.push({
        message,
        contentOffsetRows: visibleStart,
        visibleRows: Math.max(1, visibleEnd - visibleStart),
      });
    }
    itemStart = itemEnd;
    if (itemStart >= windowEnd) break;
  }
  return visible;
}

export function visibleTranscript(
  projection: StandaloneSessionProjection,
  state: TuiShellState,
  viewportRows: number,
  contentWidth = 80,
): StandaloneSessionProjection["transcript"] {
  return visibleTranscriptWindow(
    projection,
    state,
    viewportRows,
    contentWidth,
  ).map(({ message }) => message);
}

export function maxTranscriptOffset(
  projection: StandaloneSessionProjection,
  viewportRows: number,
  contentWidth = 80,
  expandedToolTurnIds: readonly string[] = [],
): number {
  const totalRows = projection.transcript.reduce(
    (total, message) =>
      total +
      transcriptItemRows(
        projection,
        message,
        contentWidth,
        expandedToolTurnIds,
      ),
    0,
  );
  return Math.max(0, totalRows - Math.max(1, viewportRows));
}

export function transcriptMessageRows(
  text: string,
  contentWidth: number,
  streaming = false,
  attachments: StandaloneSessionProjection["transcript"][number]["attachments"] = [],
): number {
  const width = Math.max(1, contentWidth);
  const contentRows = Math.max(
    1,
    text
      .split("\n")
      .reduce(
        (rows, line) => rows + Math.max(1, Math.ceil([...line].length / width)),
        0,
      ),
  );
  const attachmentRows = attachments.reduce(
    (rows, attachment) =>
      rows + (attachment.kind === "image" && attachment.base64 ? 9 : 1),
    0,
  );
  return 2 + contentRows + attachmentRows + (streaming ? 1 : 0);
}

function transcriptItemRows(
  projection: StandaloneSessionProjection,
  message: StandaloneSessionProjection["transcript"][number],
  contentWidth: number,
  expandedToolTurnIds: readonly string[],
): number {
  return (
    transcriptMessageRows(
      message.text,
      contentWidth,
      message.streaming,
      message.attachments,
    ) +
    turnActivityRows(
      projection,
      message.turnId,
      message.role,
      expandedToolTurnIds,
    )
  );
}

function turnActivityRows(
  projection: StandaloneSessionProjection,
  turnId: string | undefined,
  role: "user" | "assistant",
  expandedToolTurnIds: readonly string[],
): number {
  if (!turnId || role !== "user") return 0;
  const thinkingRows = projection.thinking.filter(
    (item) => item.turnId === turnId,
  ).length;
  const tools = projection.tools.filter((tool) => tool.turnId === turnId);
  const toolRows =
    tools.length === 0
      ? 0
      : expandedToolTurnIds.includes(turnId)
        ? 1 +
          tools.reduce(
            (rows, tool) =>
              rows +
              1 +
              (tool.error
                ? 1
                : Number(tool.displayInput !== undefined) +
                  Number(tool.displayContent !== undefined)),
            0,
          )
        : 1;
  return thinkingRows + toolRows + (thinkingRows + toolRows > 0 ? 1 : 0);
}

export function selectedPickerItem(
  state: TuiShellState,
): TuiPickerItem | undefined {
  return state.picker?.items[state.picker.selectedIndex];
}

function pickerForValue(
  value: string,
  current: TuiShellState["picker"],
): TuiShellState["picker"] {
  if (value.startsWith("/")) {
    const query = value.toLowerCase();
    const items = TUI_COMMANDS.filter((item) => item.label.startsWith(query));
    return { kind: "commands", query, selectedIndex: 0, items };
  }
  const mention = /(?:^|\s)@([^\s]*)$/u.exec(value);
  if (mention) {
    return {
      kind: "files",
      query: mention[1]?.toLowerCase() ?? "",
      selectedIndex: current?.kind === "files" ? current.selectedIndex : 0,
      items: current?.kind === "files" ? current.items : [],
    };
  }
  return undefined;
}
