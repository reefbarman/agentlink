import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import {
  TerminalWebviewController,
  type TerminalBlockStateView,
  type TerminalTabView,
  type TerminalWebviewState,
  type VsCodeApi,
} from "./terminalWebviewController.js";
import { xtermRendererFactory } from "./xtermRenderer.js";
import type { HostTerminalSurfaceAction } from "../terminalSurfaceProtocol.js";

export interface AppProps {
  vscodeApi: VsCodeApi;
  controller?: TerminalWebviewController;
}

const TERMINAL_LIST_WIDTH_KEY = "agentlink.terminal.listWidth.v1";
const DEFAULT_TERMINAL_LIST_WIDTH = 220;
const MIN_TERMINAL_LIST_WIDTH = 150;
const MAX_TERMINAL_LIST_WIDTH = 420;
const MIN_TERMINAL_CONTENT_WIDTH = 240;
const TERMINAL_LIST_KEYBOARD_STEP = 16;

function terminalListWidthBounds(totalWidth?: number): {
  minimum: number;
  maximum: number;
} {
  const availableWidth =
    totalWidth === undefined || totalWidth <= 0
      ? MAX_TERMINAL_LIST_WIDTH
      : Math.max(0, totalWidth - MIN_TERMINAL_CONTENT_WIDTH);
  const maximum = Math.min(MAX_TERMINAL_LIST_WIDTH, availableWidth);
  return {
    minimum: Math.min(MIN_TERMINAL_LIST_WIDTH, maximum),
    maximum,
  };
}

function clampTerminalListWidth(width: number, totalWidth?: number): number {
  const { minimum, maximum } = terminalListWidthBounds(totalWidth);
  return Math.max(minimum, Math.min(maximum, width));
}

function readTerminalListWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(TERMINAL_LIST_WIDTH_KEY));
    return Number.isFinite(value) && value > 0
      ? clampTerminalListWidth(value)
      : DEFAULT_TERMINAL_LIST_WIDTH;
  } catch {
    return DEFAULT_TERMINAL_LIST_WIDTH;
  }
}

function writeTerminalListWidth(width: number): void {
  try {
    window.localStorage.setItem(TERMINAL_LIST_WIDTH_KEY, String(width));
  } catch {
    // Best-effort webview preference only.
  }
}

function exitLabel(tab: TerminalTabView): string {
  if (tab.status !== "exited") return tab.status;
  if (tab.exitCode !== undefined) return `exited (${tab.exitCode})`;
  if (tab.signal !== undefined) return `exited (signal ${tab.signal})`;
  return "exited";
}

const ACTION_DETAILS: Partial<
  Record<
    HostTerminalSurfaceAction,
    { label: string; shortLabel: string; icon: string }
  >
> = {
  "rerun-command": {
    label: "Rerun command",
    shortLabel: "Rerun",
    icon: "refresh",
  },
  "interrupt-command": {
    label: "Interrupt command",
    shortLabel: "Interrupt",
    icon: "debug-pause",
  },
};

function BlockStrip({
  blockState,
  controller,
  terminalId,
}: {
  blockState?: TerminalBlockStateView;
  controller: TerminalWebviewController;
  terminalId: string;
}) {
  if (!blockState || blockState.blocks.length === 0) return null;
  if (blockState.alternateScreen) {
    return (
      <div class="terminal-block-strip tui" role="status">
        <span class="codicon codicon-screen-full" aria-hidden="true" />
        Interactive terminal application active
      </div>
    );
  }

  let command: TerminalBlockStateView["blocks"][number] | undefined;
  for (let index = blockState.blocks.length - 1; index >= 0; index -= 1) {
    const block = blockState.blocks[index];
    if (
      block.kind === "command" &&
      block.decoration !== "hidden" &&
      block.actions.some((action) => ACTION_DETAILS[action] !== undefined)
    ) {
      command = block;
      break;
    }
  }
  if (!command) return null;

  return (
    <section class="terminal-block-strip" aria-label="Command actions">
      <span class="terminal-block-mode">Command actions</span>
      <div class="terminal-block-actions">
        {command.actions.map((action) => {
          const details = ACTION_DETAILS[action];
          if (!details) return null;
          return (
            <button
              type="button"
              key={action}
              aria-label={details.label}
              title={details.label}
              onClick={() =>
                controller.runBlockAction(terminalId, command.blockId, action)
              }
            >
              <span
                class={`codicon codicon-${details.icon}`}
                aria-hidden="true"
              />
              <span>{details.shortLabel}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TerminalPane({
  active,
  blockState,
  controller,
  error,
  tab,
  warning,
}: {
  active: boolean;
  blockState?: TerminalBlockStateView;
  controller: TerminalWebviewController;
  error?: string;
  tab: TerminalTabView;
  warning?: string;
}) {
  const attachContainer = useCallback(
    (element: HTMLDivElement | null) =>
      controller.attachContainer(tab.id, element),
    [controller, tab.id],
  );

  return (
    <section
      class={`terminal-pane${active ? " active" : ""}`}
      aria-label={`${tab.title} terminal`}
      aria-hidden={!active}
    >
      {warning && <div class="terminal-warning">{warning}</div>}
      {error ? (
        <div class="terminal-state terminal-error" role="alert">
          <strong>Terminal renderer error</strong>
          <span>{error}</span>
        </div>
      ) : (
        <div class="terminal-pane-body">
          <div
            class="terminal-xterm-host"
            ref={attachContainer}
            onMouseDown={() => controller.focusActive()}
          />
          <BlockStrip
            blockState={blockState}
            controller={controller}
            terminalId={tab.id}
          />
        </div>
      )}
      {tab.status === "exited" && (
        <div class="terminal-exit-state" role="status">
          Process {exitLabel(tab)}
        </div>
      )}
    </section>
  );
}

function TerminalList({
  activeTabId,
  controller,
  tabs,
}: {
  activeTabId?: string;
  controller: TerminalWebviewController;
  tabs: readonly TerminalTabView[];
}) {
  return (
    <aside class="terminal-list" aria-label="Open terminals">
      <div class="terminal-list-heading">
        <span>Terminals</span>
        <span
          class="terminal-list-count"
          aria-label={`${tabs.length} open terminals`}
        >
          {tabs.length}
        </span>
      </div>
      <div class="terminal-list-items" role="list">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const sandbox = tab.channelKind === "agent-sandbox";
          const native = tab.channelKind === "agent-native";
          const authorityLabel = sandbox
            ? "Sandbox"
            : native
              ? "Native Agent"
              : "Host Shell";
          const activityLabel =
            tab.agentActivity === "running"
              ? "Agent command running"
              : tab.agentActivity === "unread"
                ? "Agent command finished — output not viewed"
                : undefined;
          return (
            <div
              class={`terminal-list-item${active ? " active" : ""}${tab.agentActivity ? ` agent-${tab.agentActivity}` : ""}`}
              role="listitem"
              key={tab.id}
            >
              <button
                type="button"
                class="terminal-list-select"
                aria-current={active ? "true" : undefined}
                aria-label={`Focus ${tab.title} (${authorityLabel})${activityLabel ? `. ${activityLabel}` : ""}`}
                title={`${tab.title} — ${tab.cwd}${activityLabel ? ` — ${activityLabel}` : ""}`}
                onClick={() => controller.selectTerminal(tab.id)}
              >
                <span
                  class={
                    native
                      ? "terminal-agentlink-icon"
                      : `codicon codicon-${sandbox ? "shield terminal-sandbox-icon" : "terminal"}`
                  }
                  title={
                    sandbox
                      ? "Fresh sandbox per command"
                      : native
                        ? "Unsandboxed agent command"
                        : undefined
                  }
                  aria-hidden="true"
                />
                <span class="terminal-list-name">{tab.title}</span>
                <span
                  class={`terminal-status ${tab.agentActivity ? `agent-${tab.agentActivity}` : tab.status}`}
                  title={activityLabel ?? exitLabel(tab)}
                  aria-label={activityLabel ?? exitLabel(tab)}
                />
              </button>
              <button
                type="button"
                class="terminal-list-close"
                aria-label={`Kill ${tab.title}`}
                title={`Kill ${tab.title}`}
                onClick={() => controller.closeTerminal(tab.id)}
              >
                <span class="codicon codicon-trash" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function SearchBar({
  controller,
  onClose,
}: {
  controller: TerminalWebviewController;
  onClose(): void;
}) {
  const [term, setTerm] = useState("");

  const clear = () => {
    setTerm("");
    controller.clearSearch();
    onClose();
    controller.focusActive();
  };

  return (
    <form
      class="terminal-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        controller.findNext(term);
      }}
    >
      <input
        aria-label="Search terminal"
        placeholder="Search"
        value={term}
        onInput={(event) => setTerm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            clear();
          }
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            controller.findPrevious(term);
          }
        }}
      />
      <button
        type="button"
        aria-label="Previous search result"
        title="Previous match"
        disabled={!term}
        onClick={() => controller.findPrevious(term)}
      >
        <span class="codicon codicon-arrow-up" aria-hidden="true" />
      </button>
      <button
        type="submit"
        aria-label="Next search result"
        title="Next match"
        disabled={!term}
      >
        <span class="codicon codicon-arrow-down" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Clear terminal search"
        title="Clear search"
        disabled={!term}
        onClick={clear}
      >
        <span class="codicon codicon-close" aria-hidden="true" />
      </button>
    </form>
  );
}

function TerminalConfirmation({
  controller,
  confirmation,
}: {
  controller: TerminalWebviewController;
  confirmation: NonNullable<TerminalWebviewState["confirmation"]>;
}) {
  return (
    <div class="terminal-confirmation-backdrop" role="presentation">
      <section
        class="terminal-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="terminal-confirmation-title"
        aria-describedby="terminal-confirmation-message"
      >
        <strong id="terminal-confirmation-title">{confirmation.title}</strong>
        <span id="terminal-confirmation-message">{confirmation.message}</span>
        <div class="terminal-confirmation-actions">
          <button
            type="button"
            class="secondary"
            onClick={() => controller.respondToConfirmation(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="primary"
            onClick={() => controller.respondToConfirmation(true)}
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function FallbackState({
  controller,
  message,
}: {
  controller: TerminalWebviewController;
  message: string;
}) {
  return (
    <div class="terminal-state terminal-fallback">
      <strong>Integrated terminal unavailable</strong>
      <span>{message}</span>
      <button type="button" onClick={() => controller.openNativeFallback()}>
        Open Native Terminal
      </button>
    </div>
  );
}

function EmptyState({
  controller,
  creating,
}: {
  controller: TerminalWebviewController;
  creating: boolean;
}) {
  return (
    <div class="terminal-state terminal-empty">
      <strong>No terminals</strong>
      <span>Create a host terminal when you are ready.</span>
      <button
        type="button"
        disabled={creating}
        onClick={() => controller.createTerminal()}
      >
        {creating ? "Creating…" : "New Terminal"}
      </button>
    </div>
  );
}

export function App({ vscodeApi, controller: providedController }: AppProps) {
  const [controller] = useState(
    () =>
      providedController ??
      new TerminalWebviewController({
        vscodeApi,
        rendererFactory: xtermRendererFactory,
      }),
  );
  const [state, setState] = useState<TerminalWebviewState>(() =>
    controller.getSnapshot(),
  );
  const [searchVisible, setSearchVisible] = useState(false);
  const [wideLayout, setWideLayout] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 700px)").matches
      : true,
  );
  const [terminalListPreference, setTerminalListPreference] = useState<
    "auto" | "shown" | "hidden"
  >("auto");
  const [terminalListWidth, setTerminalListWidth] = useState(
    readTerminalListWidth,
  );
  const [terminalListResizing, setTerminalListResizing] = useState(false);
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const unmount = controller.mount(window);
    return () => {
      unsubscribe();
      unmount();
      if (!providedController) controller.dispose();
    };
  }, [controller, providedController]);

  useEffect(() => {
    if (!searchVisible) controller.focusActive();
  }, [controller, searchVisible, state.focusRequest]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 700px)");
    const update = (event: MediaQueryListEvent | MediaQueryList) =>
      setWideLayout(event.matches);
    update(media);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    controller.fitActive();
  }, [
    controller,
    state.activeTabId,
    terminalListPreference,
    terminalListWidth,
    wideLayout,
    workbenchWidth,
  ]);

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) return;
    const updateWidth = () =>
      setWorkbenchWidth(workbench.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workbench);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchVisible(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const effectiveTerminalListWidth = clampTerminalListWidth(
    terminalListWidth,
    workbenchWidth,
  );
  const terminalListWidthBoundsForWorkbench =
    terminalListWidthBounds(workbenchWidth);

  const commitTerminalListWidth = (width: number): void => {
    const nextWidth = clampTerminalListWidth(width, workbenchWidth);
    setTerminalListWidth(nextWidth);
    writeTerminalListWidth(nextWidth);
  };

  const handleTerminalListResizeStart = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const workbench = workbenchRef.current;
    if (!workbench) return;
    event.preventDefault();
    resizeCleanupRef.current?.();

    let latestWidth = effectiveTerminalListWidth;
    setTerminalListResizing(true);
    const onMove = (moveEvent: MouseEvent) => {
      const rect = workbench.getBoundingClientRect();
      latestWidth = clampTerminalListWidth(
        rect.right - moveEvent.clientX,
        rect.width,
      );
      setTerminalListWidth(latestWidth);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finish);
      resizeCleanupRef.current = null;
    };
    const finish = () => {
      cleanup();
      writeTerminalListWidth(latestWidth);
      setTerminalListResizing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finish);
    resizeCleanupRef.current = cleanup;
  };

  const handleTerminalListResizeKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey
      ? TERMINAL_LIST_KEYBOARD_STEP * 2
      : TERMINAL_LIST_KEYBOARD_STEP;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      commitTerminalListWidth(effectiveTerminalListWidth + step);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      commitTerminalListWidth(effectiveTerminalListWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      commitTerminalListWidth(MIN_TERMINAL_LIST_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      commitTerminalListWidth(MAX_TERMINAL_LIST_WIDTH);
    }
  };

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const terminalListVisible =
    terminalListPreference === "shown" ||
    (terminalListPreference === "auto" &&
      (wideLayout || state.tabs.length > 1));

  return (
    <main class="terminal-app">
      <header class="terminal-toolbar">
        <div class="terminal-instance-control">
          {activeTab && (
            <span
              class={`terminal-status ${activeTab.status}`}
              aria-hidden="true"
            />
          )}
          {activeTab && (
            <span
              class="terminal-active-label"
              title={`${activeTab.title} — ${activeTab.cwd}`}
            >
              <span
                class={
                  activeTab.channelKind === "agent-native"
                    ? "terminal-agentlink-icon"
                    : `codicon codicon-${activeTab.channelKind === "agent-sandbox" ? "shield terminal-sandbox-icon" : "terminal"}`
                }
                title={
                  activeTab.channelKind === "agent-sandbox"
                    ? "Fresh sandbox per command"
                    : activeTab.channelKind === "agent-native"
                      ? "Unsandboxed agent command"
                      : undefined
                }
                aria-hidden="true"
              />
              <span>{activeTab.title}</span>
            </span>
          )}
        </div>
        <div class="terminal-actions" aria-label="Terminal actions">
          <button
            type="button"
            aria-label="New Terminal"
            title="New Terminal"
            disabled={state.creating}
            onClick={() => controller.createTerminal()}
          >
            <span class="codicon codicon-add" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Paste into Terminal"
            title="Paste"
            disabled={!activeTab || activeTab.status !== "running"}
            onClick={() => {
              if (activeTab) controller.pasteTerminal(activeTab.id);
            }}
          >
            <span class="codicon codicon-clippy" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Find in Terminal"
            title="Find in Terminal"
            disabled={!activeTab}
            onClick={() => setSearchVisible((visible) => !visible)}
          >
            <span class="codicon codicon-search" aria-hidden="true" />
          </button>
          <button
            type="button"
            class={terminalListVisible ? "active" : undefined}
            aria-label="Toggle terminal list"
            aria-pressed={terminalListVisible}
            title={
              terminalListVisible ? "Hide Terminal List" : "Show Terminal List"
            }
            disabled={state.tabs.length === 0}
            onClick={() =>
              setTerminalListPreference(
                terminalListVisible ? "hidden" : "shown",
              )
            }
          >
            <span class="codicon codicon-list-tree" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={activeTab ? `Kill ${activeTab.title}` : "Kill Terminal"}
            title="Kill Terminal"
            disabled={!activeTab}
            onClick={() => {
              if (activeTab) controller.closeTerminal(activeTab.id);
            }}
          >
            <span class="codicon codicon-trash" aria-hidden="true" />
          </button>
        </div>
        {activeTab && searchVisible && (
          <SearchBar
            controller={controller}
            onClose={() => setSearchVisible(false)}
          />
        )}
      </header>

      <div
        class={`terminal-workbench${terminalListVisible ? " list-visible" : ""}${terminalListResizing ? " resizing" : ""}`}
        ref={workbenchRef}
      >
        <div class="terminal-content">
          {state.phase === "loading" && (
            <div class="terminal-state">Connecting to terminal host…</div>
          )}
          {state.phase === "ready" && state.tabs.length === 0 && state.error ? (
            <div class="terminal-state terminal-error" role="alert">
              <strong>Terminal error</strong>
              <span>{state.error}</span>
            </div>
          ) : state.phase === "ready" &&
            state.tabs.length === 0 &&
            state.fallback ? (
            <FallbackState
              controller={controller}
              message={state.fallback.message}
            />
          ) : state.phase === "ready" && state.tabs.length === 0 ? (
            <EmptyState controller={controller} creating={state.creating} />
          ) : null}
          {state.phase === "ready" && state.tabs.length > 0 && state.error && (
            <div class="terminal-global-error" role="alert">
              {state.error}
            </div>
          )}

          {state.tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              active={tab.id === state.activeTabId}
              blockState={state.blockStates[tab.id]}
              controller={controller}
              error={state.rendererErrors[tab.id]}
              tab={tab}
              warning={state.replayWarnings[tab.id]}
            />
          ))}
          {state.confirmation && (
            <TerminalConfirmation
              controller={controller}
              confirmation={state.confirmation}
            />
          )}
        </div>
        {state.phase === "ready" &&
          state.tabs.length > 0 &&
          terminalListVisible && (
            <>
              <div
                aria-label="Resize terminal list"
                aria-orientation="vertical"
                aria-valuemax={terminalListWidthBoundsForWorkbench.maximum}
                aria-valuemin={terminalListWidthBoundsForWorkbench.minimum}
                aria-valuenow={Math.round(effectiveTerminalListWidth)}
                aria-valuetext={`${Math.round(effectiveTerminalListWidth)} pixels; Left or Up expands, Right or Down contracts`}
                class="terminal-list-resize-handle"
                onKeyDown={(event) =>
                  handleTerminalListResizeKeyDown(
                    event as unknown as KeyboardEvent,
                  )
                }
                onMouseDown={(event) =>
                  handleTerminalListResizeStart(event as unknown as MouseEvent)
                }
                role="separator"
                tabIndex={0}
                title="Drag to resize the terminal list"
              />
              <div
                class="terminal-list-shell"
                style={{ width: `${effectiveTerminalListWidth}px` }}
              >
                <TerminalList
                  activeTabId={state.activeTabId}
                  controller={controller}
                  tabs={state.tabs}
                />
              </div>
            </>
          )}
      </div>
    </main>
  );
}
