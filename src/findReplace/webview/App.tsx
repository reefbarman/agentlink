import { useState, useEffect, useCallback } from "preact/hooks";
import type { FindReplacePreviewData } from "./types.js";
import { FileSection } from "./components/FileSection.js";

interface AppProps {
  vscodeApi: ReturnType<typeof acquireVsCodeApi>;
}

export function App({ vscodeApi }: AppProps) {
  const [data, setData] = useState<FindReplacePreviewData | null>(null);
  const [accepted, setAccepted] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "showPreview") {
        const previewData = msg.data as FindReplacePreviewData;
        setData(previewData);
        const map = new Map<string, boolean>();
        for (const fg of previewData.fileGroups) {
          for (const m of fg.matches) {
            map.set(m.id, true);
          }
        }
        setAccepted(map);
      }
    };
    window.addEventListener("message", handler);
    vscodeApi.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const toggleMatch = useCallback(
    (matchId: string) => {
      setAccepted((prev) => {
        const next = new Map(prev);
        const newVal = !next.get(matchId);
        next.set(matchId, newVal);
        vscodeApi.postMessage({
          type: "toggleMatch",
          matchId,
          accepted: newVal,
        });
        return next;
      });
    },
    [vscodeApi],
  );

  const toggleFile = useCallback(
    (filePath: string, value: boolean) => {
      if (!data) return;
      setAccepted((prev) => {
        const next = new Map(prev);
        const fileIdx = data.fileGroups.findIndex((fg) => fg.path === filePath);
        if (fileIdx >= 0) {
          for (const m of data.fileGroups[fileIdx].matches) {
            next.set(m.id, value);
          }
        }
        vscodeApi.postMessage({
          type: "toggleFile",
          filePath,
          accepted: value,
        });
        return next;
      });
    },
    [data, vscodeApi],
  );

  const toggleAll = useCallback(
    (value: boolean) => {
      setAccepted((prev) => {
        const next = new Map(prev);
        for (const id of next.keys()) {
          next.set(id, value);
        }
        vscodeApi.postMessage({ type: "toggleAll", accepted: value });
        return next;
      });
    },
    [vscodeApi],
  );

  if (!data) {
    return <div class="fr-loading">Loading preview…</div>;
  }

  const acceptedCount = [...accepted.values()].filter(Boolean).length;
  const allSelected = acceptedCount === data.totalMatches;

  return (
    <div class="fr-preview">
      <div class="fr-header">
        <div class="fr-find-replace">
          <code class="fr-old">{data.findText}</code>
          <span class="codicon codicon-arrow-right fr-arrow" />
          <code class="fr-new">{data.replaceText}</code>
          {data.isRegex && <span class="fr-badge">regex</span>}
        </div>
        <div class="fr-summary">
          {acceptedCount} of {data.totalMatches} changes selected
        </div>
        <button
          class="fr-select-all-btn"
          onClick={() => toggleAll(!allSelected)}
        >
          <span
            class={`codicon ${allSelected ? "codicon-check-all" : "codicon-checklist"}`}
          />
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      </div>
      <div class="fr-body">
        {data.fileGroups.map((fg, fi) => {
          const fileAccepted = fg.matches.every((m) => accepted.get(m.id));
          return (
            <FileSection
              key={fg.path}
              group={fg}
              fileIndex={fi}
              accepted={accepted}
              allAccepted={fileAccepted}
              onToggleMatch={toggleMatch}
              onToggleFile={(val) => toggleFile(fg.path, val)}
            />
          );
        })}
      </div>
    </div>
  );
}
