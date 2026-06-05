import "monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api.js";

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { BrowserGatewayThemeSnapshot } from "../../../shared/types";

interface DiffDetail {
  requestId: string;
  filePath: string;
  operation: string;
  outsideWorkspace: boolean;
  createdAt: number;
  originalContent: string;
  proposedContent: string;
}

type DiffLoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; detail: DiffDetail }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "too_large"; message: string }
  | { kind: "error"; message: string };

interface BrowserDiffViewerProps {
  requestId: string | null;
  authToken: string;
  buildApiPath: (pathname: string) => string;
  theme?: BrowserGatewayThemeSnapshot;
}

type MonacoModule = typeof MonacoApi;

type MonacoThemeColorKey = Parameters<
  MonacoModule["editor"]["defineTheme"]
>[1]["colors"] extends infer Colors
  ? keyof NonNullable<Colors>
  : string;

const MONACO_THEME_NAME = "agentlink-browser-gateway";
const MIN_SIDE_BY_SIDE_WIDTH = 780;
const MOBILE_DIFF_MEDIA_QUERY = "(max-width: 720px)";

let monacoPromise: Promise<MonacoModule> | null = null;
let monacoWorkersConfigured = false;

function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = import("monaco-editor/esm/vs/editor/editor.api.js");
  }
  return monacoPromise;
}

function configureMonacoWorkers(): void {
  if (monacoWorkersConfigured) return;
  monacoWorkersConfigured = true;
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const workerPath = getWorkerPath(label);
      return new Worker(workerPath, { type: "module" });
    },
  };
}

function getWorkerPath(label: string): string {
  switch (label) {
    case "json":
      return "/monaco-json.worker.js";
    case "css":
    case "scss":
    case "less":
      return "/monaco-css.worker.js";
    case "html":
    case "handlebars":
    case "razor":
      return "/monaco-html.worker.js";
    case "typescript":
    case "javascript":
      return "/monaco-ts.worker.js";
    default:
      return "/monaco-editor.worker.js";
  }
}

function inferLanguageId(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "typescript";
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (lower.endsWith(".jsx")) return "javascript";
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".less")) return "less";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) return "xml";
  if (
    lower.endsWith(".sh") ||
    lower.endsWith(".bash") ||
    lower.endsWith(".zsh")
  ) {
    return "shell";
  }
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "cpp";
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".hpp")
  ) {
    return "cpp";
  }
  return "plaintext";
}

function readCssVariable(name: string): string | undefined {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    name,
  );
  return value.trim() || undefined;
}

function cssColor(name: string, fallback: string): string {
  return readCssVariable(name) ?? fallback;
}

function defineTheme(
  monaco: MonacoModule,
  theme?: BrowserGatewayThemeSnapshot,
): void {
  const dark =
    theme?.colorScheme !== "light" && theme?.colorScheme !== "hc-light";
  const base: MonacoApi.editor.BuiltinTheme =
    theme?.colorScheme === "hc-light"
      ? "hc-light"
      : theme?.colorScheme === "hc"
        ? "hc-black"
        : dark
          ? "vs-dark"
          : "vs";

  const colors: Record<MonacoThemeColorKey, string> = {
    "editor.background": cssColor(
      "--vscode-editor-background",
      dark ? "#1e1e1e" : "#ffffff",
    ),
    "editor.foreground": cssColor(
      "--vscode-editor-foreground",
      dark ? "#d4d4d4" : "#333333",
    ),
    "editorLineNumber.foreground": cssColor(
      "--vscode-editorLineNumber-foreground",
      dark ? "#858585" : "#237893",
    ),
    "editorLineNumber.activeForeground": cssColor(
      "--vscode-editorLineNumber-activeForeground",
      dark ? "#c6c6c6" : "#0b216f",
    ),
    "editor.selectionBackground": cssColor(
      "--vscode-editor-selectionBackground",
      dark ? "#264f78" : "#add6ff",
    ),
    "editor.inactiveSelectionBackground": cssColor(
      "--vscode-editor-inactiveSelectionBackground",
      dark ? "#3a3d41" : "#e5ebf1",
    ),
    // NOTE: diffEditor.{inserted,removed}{Text,Line}Background are intentionally
    // NOT set here. We let Monaco's base theme (vs/vs-dark/hc-*) supply its
    // built-in diff colors, which are VS Code's subtle defaults. Forwarding the
    // captured `--vscode-diffEditor-*` values made changed lines render as a
    // bright near-opaque band (some themes / the webview expose those colors at
    // a much higher opacity than VS Code's diff editor actually paints). Because
    // Monaco writes its own values onto `.monaco-editor`, the built-ins also
    // shield against any bright `--vscode-diffEditor-*` value set on `:root` by
    // the gateway theme snapshot (closer ancestor wins).
    "scrollbarSlider.background": cssColor(
      "--vscode-scrollbarSlider-background",
      "#79797966",
    ),
    "scrollbarSlider.hoverBackground": cssColor(
      "--vscode-scrollbarSlider-hoverBackground",
      "#646464b3",
    ),
    "scrollbarSlider.activeBackground": cssColor(
      "--vscode-scrollbarSlider-activeBackground",
      "#bfbfbf66",
    ),
  };

  monaco.editor.defineTheme(MONACO_THEME_NAME, {
    base,
    inherit: true,
    rules: [],
    colors,
  });
  monaco.editor.setTheme(MONACO_THEME_NAME);
}

function createModelUri(
  monaco: MonacoModule,
  viewerInstanceId: string,
  requestId: string,
  side: "original" | "proposed",
  filePath: string,
): MonacoApi.Uri {
  const normalizedPath = filePath.replace(/^\/+/, "");
  return monaco.Uri.parse(
    `agentlink-diff:///${encodeURIComponent(viewerInstanceId)}/${encodeURIComponent(requestId)}/${side}/${normalizedPath}`,
  );
}

export function BrowserDiffViewer({
  requestId,
  authToken,
  buildApiPath,
  theme,
}: BrowserDiffViewerProps) {
  const viewerInstanceIdRef = useRef(
    `viewer-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<MonacoApi.editor.ITextModel | null>(null);
  const proposedModelRef = useRef<MonacoApi.editor.ITextModel | null>(null);
  const [loadState, setLoadState] = useState<DiffLoadState>({ kind: "idle" });
  const [editorReady, setEditorReady] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [mobileDiffLayout, setMobileDiffLayout] = useState(false);

  const renderSideBySide =
    !mobileDiffLayout && containerWidth >= MIN_SIDE_BY_SIDE_WIDTH;

  useEffect(() => {
    configureMonacoWorkers();
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(MOBILE_DIFF_MEDIA_QUERY);
    const syncMobileDiffLayout = () => setMobileDiffLayout(mediaQuery.matches);
    syncMobileDiffLayout();
    mediaQuery.addEventListener("change", syncMobileDiffLayout);
    return () => mediaQuery.removeEventListener("change", syncMobileDiffLayout);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry?.contentRect.width ?? 0;
      setContainerWidth(width);
      editorRef.current?.layout();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;

    void loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        defineTheme(monaco, theme);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [theme]);

  useEffect(() => {
    if (!requestId) {
      setLoadState({ kind: "idle" });
      return;
    }

    const controller = new AbortController();
    setLoadState({ kind: "loading" });

    void fetch(buildApiPath(`/api/diff/${encodeURIComponent(requestId)}`), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setLoadState({ kind: "unauthorized" });
          return;
        }
        if (response.status === 404) {
          setLoadState({ kind: "not_found" });
          return;
        }
        if (response.status === 413) {
          const body = (await response.json().catch(() => null)) as {
            totalChars?: number;
            maxChars?: number;
          } | null;
          const totalChars = body?.totalChars;
          const maxChars = body?.maxChars;
          setLoadState({
            kind: "too_large",
            message:
              typeof totalChars === "number" && typeof maxChars === "number"
                ? `Diff is too large for browser preview (${totalChars.toLocaleString()} chars, limit ${maxChars.toLocaleString()}). Open it in VS Code to review.`
                : "Diff is too large for browser preview. Open it in VS Code to review.",
          });
          return;
        }
        if (!response.ok) {
          setLoadState({
            kind: "error",
            message: `Diff fetch failed: ${response.status}`,
          });
          return;
        }
        const detail = (await response.json()) as DiffDetail;
        if (controller.signal.aborted) return;
        setLoadState({ kind: "ready", detail });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({ kind: "error", message: String(err) });
      });

    return () => controller.abort();
  }, [authToken, buildApiPath, requestId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || loadState.kind !== "ready") return;

    let disposed = false;

    void loadMonaco().then((monaco) => {
      if (disposed) return;
      const detail = loadState.detail;
      const languageId = inferLanguageId(detail.filePath);
      defineTheme(monaco, theme);

      originalModelRef.current?.dispose();
      proposedModelRef.current?.dispose();

      const originalModel = monaco.editor.createModel(
        detail.originalContent,
        languageId,
        createModelUri(
          monaco,
          viewerInstanceIdRef.current,
          detail.requestId,
          "original",
          detail.filePath,
        ),
      );
      const proposedModel = monaco.editor.createModel(
        detail.proposedContent,
        languageId,
        createModelUri(
          monaco,
          viewerInstanceIdRef.current,
          detail.requestId,
          "proposed",
          detail.filePath,
        ),
      );
      originalModelRef.current = originalModel;
      proposedModelRef.current = proposedModel;

      if (!editorRef.current) {
        editorRef.current = monaco.editor.createDiffEditor(container, {
          automaticLayout: false,
          contextmenu: false,
          domReadOnly: true,
          diffWordWrap: "on",
          enableSplitViewResizing: true,
          folding: false,
          glyphMargin: false,
          ignoreTrimWhitespace: false,
          lineNumbers: "on",
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: true,
          renderIndicators: true,
          renderOverviewRuler: false,
          renderSideBySide,
          renderWhitespace: "selection",
          scrollBeyondLastLine: false,
          scrollbar: {
            alwaysConsumeMouseWheel: false,
            horizontal: "auto",
            vertical: "auto",
            useShadows: false,
            verticalScrollbarSize: 12,
            horizontalScrollbarSize: 12,
          },
          smoothScrolling: true,
          useInlineViewWhenSpaceIsLimited: true,
          wordWrap: "on",
          wrappingIndent: "same",
        });
      }

      editorRef.current.updateOptions({ renderSideBySide });
      editorRef.current.setModel({
        original: originalModel,
        modified: proposedModel,
      });
      editorRef.current.layout();
      setEditorReady(true);
    });

    return () => {
      disposed = true;
      setEditorReady(false);
    };
  }, [loadState, renderSideBySide, theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide });
    editorRef.current?.layout();
  }, [renderSideBySide]);

  useEffect(() => {
    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      originalModelRef.current?.dispose();
      originalModelRef.current = null;
      proposedModelRef.current?.dispose();
      proposedModelRef.current = null;
    };
  }, []);

  const statusText = useMemo(() => {
    switch (loadState.kind) {
      case "idle":
        return "Select a diff to preview it.";
      case "loading":
        return "Loading diff…";
      case "ready":
        return editorReady ? "Read-only preview" : "Preparing editor…";
      case "not_found":
        return "This diff is no longer pending.";
      case "unauthorized":
        return "Browser authorization expired. Re-pair this browser to view diffs.";
      case "too_large":
        return loadState.message;
      case "error":
        return loadState.message;
    }
  }, [editorReady, loadState]);

  return (
    <div class="browser-diff-viewer">
      <div class="browser-diff-editor-shell">
        {loadState.kind === "ready" ? null : (
          <div class="browser-diff-state">{statusText}</div>
        )}
        <div
          ref={containerRef}
          class={`browser-diff-editor ${loadState.kind === "ready" ? "ready" : ""}`}
          aria-label="Read-only diff preview"
        />
      </div>
      <div class="browser-diff-status">{statusText}</div>
    </div>
  );
}
