import { useState, useRef, useEffect, useCallback } from "preact/hooks";

interface FileResult {
  path: string;
  kind: "file" | "folder";
}

interface FilePickerProps {
  query: string;
  anchor: { left: number; bottom: number };
  onSelect: (path: string) => void;
  onClose: () => void;
  vscodeApi: { postMessage: (msg: unknown) => void };
}

let searchRequestId = 0;

export function FilePicker({
  query,
  anchor,
  onSelect,
  onClose,
  vscodeApi,
}: FilePickerProps) {
  const [results, setResults] = useState<FileResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef("");

  // Search when query changes (empty query returns all files)
  useEffect(() => {
    const reqId = `file-search-${++searchRequestId}`;
    activeRequestRef.current = reqId;
    setLoading(true);

    vscodeApi.postMessage({
      command: "agentSearchFiles",
      query: query.trim() || "*",
      requestId: reqId,
    });
  }, [query, vscodeApi]);

  // Listen for search results
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "agentFileSearchResults") {
        if (msg.requestId !== activeRequestRef.current) return;
        setResults(msg.files);
        setSelectedIndex(0);
        setLoading(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) {
            onSelect(results[selectedIndex].path);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, onSelect, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const selected = containerRef.current?.querySelector(
      ".file-picker-item.selected",
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      ref={containerRef}
      class="file-picker"
      style={{ left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }}
    >
      <div class="file-picker-header">
        <span class="file-picker-at">@</span>
        <span class="file-picker-label">
          {query ? `Searching: ${query}` : "Attach a file"}
        </span>
      </div>
      {loading && results.length === 0 && (
        <div class="file-picker-empty">Searching...</div>
      )}
      {!loading && results.length === 0 && query.trim() && (
        <div class="file-picker-empty">No files found</div>
      )}
      {results.map((file, i) => {
        const parts = file.path.split("/");
        const name = parts.pop()!;
        const dir = parts.join("/");
        return (
          <div
            key={file.path}
            class={`file-picker-item ${i === selectedIndex ? "selected" : ""}`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => onSelect(file.path)}
          >
            <i
              class={`codicon ${file.kind === "folder" ? "codicon-folder" : "codicon-file"}`}
            />
            <span class="file-picker-name">{name}</span>
            {dir && <span class="file-picker-dir">{dir}</span>}
          </div>
        );
      })}
    </div>
  );
}
