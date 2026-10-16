import type * as MonacoApi from "./browserMonaco";

import {
  configureMonacoWorkers,
  defineTheme,
  inferLanguageId,
  loadMonaco,
} from "./browserMonacoLoader";
import { useEffect, useRef, useState } from "preact/hooks";

import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";

/** The Assistant server's read-only file route for the selected project. */
export const PROJECT_FILE_ROUTE = "/api/ask-agent/project-file";

interface ProjectFileResponse {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

type FileLoadState =
  | { kind: "loading" }
  | { kind: "ready"; file: ProjectFileResponse }
  | { kind: "error"; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  file_not_found:
    "This file does not exist (it may have been moved or deleted).",
  outside_project: "This file is outside the current project.",
  not_a_file: "This is a folder, not a file.",
  binary_file: "This file is not text, so it cannot be shown here.",
  path_invalid: "This file path is not valid.",
  project_not_found: "No project is selected.",
  authentication_required: "Your sign-in has expired. Reload to pair again.",
};

export interface BrowserFileViewerProps {
  path: string;
  line?: number;
  theme?: BrowserGatewayThemeSnapshot;
  onClose: () => void;
}

function basename(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A read-only view of one project file, opened from a file link in a chat.
 * Uses the same lazily loaded Monaco editor as the diff viewer.
 */
export function BrowserFileViewer({
  path,
  line,
  theme,
  onClose,
}: BrowserFileViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<MonacoApi.editor.ITextModel | null>(null);
  const [state, setState] = useState<FileLoadState>({ kind: "loading" });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch(`${PROJECT_FILE_ROUTE}?path=${encodeURIComponent(path)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Partial<
          ProjectFileResponse & { error: string }
        >;
        if (controller.signal.aborted) return;
        if (!response.ok || typeof body.content !== "string") {
          setState({
            kind: "error",
            message:
              (body.error && ERROR_MESSAGES[body.error]) ??
              `Could not open this file (${body.error ?? response.status}).`,
          });
          return;
        }
        setState({ kind: "ready", file: body as ProjectFileResponse });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: `Could not open this file: ${String(error)}`,
        });
      });
    return () => controller.abort();
  }, [path]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || state.kind !== "ready") return;
    let disposed = false;
    configureMonacoWorkers();
    void loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        defineTheme(monaco, theme);
        modelRef.current?.dispose();
        const model = monaco.editor.createModel(
          state.file.content,
          inferLanguageId(state.file.path),
        );
        modelRef.current = model;
        if (!editorRef.current) {
          editorRef.current = monaco.editor.create(container, {
            automaticLayout: true,
            contextmenu: false,
            domReadOnly: true,
            readOnly: true,
            folding: true,
            glyphMargin: false,
            lineNumbers: "on",
            minimap: { enabled: false },
            renderWhitespace: "selection",
            scrollBeyondLastLine: false,
            scrollbar: {
              alwaysConsumeMouseWheel: false,
              useShadows: false,
              verticalScrollbarSize: 12,
              horizontalScrollbarSize: 12,
            },
            wordWrap: "on",
            wrappingIndent: "same",
          });
        }
        editorRef.current.setModel(model);
        if (line && line > 0) {
          const target = Math.min(line, model.getLineCount());
          editorRef.current.revealLineInCenter(target);
          editorRef.current.setSelection({
            startLineNumber: target,
            startColumn: 1,
            endLineNumber: target,
            endColumn: model.getLineMaxColumn(target),
          });
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          kind: "error",
          message: `The file viewer failed to load: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      disposed = true;
    };
  }, [line, state, theme]);

  useEffect(
    () => () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      modelRef.current?.dispose();
      modelRef.current = null;
    },
    [],
  );

  const shownPath = state.kind === "ready" ? state.file.path : path;
  const directory = shownPath.split("/").slice(0, -1).join("/");
  return (
    <div
      class="browser-file-viewer-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="browser-file-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`File ${shownPath}`}
      >
        <header class="browser-file-viewer-header">
          <i class="codicon codicon-file" aria-hidden="true" />
          <span class="browser-file-viewer-name" title={shownPath}>
            {basename(shownPath)}
          </span>
          {directory ? (
            <span class="browser-file-viewer-directory">{directory}</span>
          ) : null}
          <span class="browser-file-viewer-badge">Read-only</span>
          <button
            class="icon-button"
            type="button"
            aria-label="Close file"
            onClick={onClose}
          >
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </header>
        {state.kind === "ready" && state.file.truncated ? (
          <div class="browser-file-viewer-note" role="status">
            Showing the first {formatSize(state.file.content.length)} of{" "}
            {formatSize(state.file.size)}.
          </div>
        ) : null}
        {state.kind === "ready" ? null : (
          <div
            class="browser-file-viewer-state"
            role={state.kind === "error" ? "alert" : "status"}
          >
            {state.kind === "loading" ? "Loading file…" : state.message}
          </div>
        )}
        <div
          ref={containerRef}
          class={`browser-file-viewer-editor ${state.kind === "ready" ? "ready" : ""}`}
          aria-label="Read-only file contents"
        />
      </div>
    </div>
  );
}
