import type * as MonacoApi from "./browserMonaco";
import {
  configureMonacoWorkers,
  defineTheme,
  inferLanguageId,
  loadMonaco,
  type MonacoModule,
} from "./browserMonacoLoader";

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";

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

const MIN_SIDE_BY_SIDE_WIDTH = 780;
const MOBILE_DIFF_MEDIA_QUERY = "(max-width: 720px)";

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

    void loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        const detail = loadState.detail;
        const languageId = inferLanguageId(detail.filePath);
        defineTheme(monaco, theme);

        // Detach the previous models from the diff widget before disposing them.
        // Disposing a TextModel that the DiffEditorWidget still references throws
        // "TextModel got disposed before DiffEditorWidget model got reset".
        editorRef.current?.setModel(null);
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
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message =
          error instanceof Error ? error.message : "unknown chunk load error";
        setLoadState({
          kind: "error",
          message: `Diff editor failed to load: ${message}`,
        });
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
