import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import DOMPurify from "dompurify";
import { Marked } from "marked";
import { matchFilePaths } from "./filePathLinks";
import { renderMarkdownTaskCheckbox } from "./markdownTaskCheckbox";

type SpecialBlock =
  | { kind: "mermaid"; source: string }
  | { kind: "vega"; source: string }
  | { kind: "vega-lite"; source: string };

let mermaidRendererPromise:
  | Promise<typeof import("./mermaidRenderer")>
  | undefined;
let vegaRendererPromise: Promise<typeof import("./vegaRenderer")> | undefined;

function loadMermaidRenderer() {
  mermaidRendererPromise ??= import("./mermaidRenderer");
  return mermaidRendererPromise;
}

function loadVegaRenderer() {
  vegaRendererPromise ??= import("./vegaRenderer");
  return vegaRendererPromise;
}

const SPECIAL_FENCE_RE =
  /```(mermaid|vega-lite|vega)[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSpecialBlockContainer(idx: number, block: SpecialBlock): string {
  const escapedCode = escapeHtml(block.source);
  const blockClass = block.kind === "mermaid" ? "mermaid" : "vega";
  const title =
    block.kind === "mermaid"
      ? "Diagram"
      : block.kind === "vega-lite"
        ? "Vega-Lite Chart"
        : "Vega Chart";
  return `<div class="special-block-container ${blockClass}-container" data-special-idx="${idx}" data-special-kind="${block.kind}"><div class="special-block-render ${blockClass}-render"><pre><code>${escapedCode}</code></pre></div><div class="special-block-actions ${blockClass}-actions"><button type="button" class="special-block-toggle-code">Show Code</button><button type="button" class="special-block-popout">Pop Out</button></div><pre class="special-block-source ${blockClass}-source" style="display:none"><code>${escapedCode}</code></pre><div class="special-block-sr-only">${title}</div></div>`;
}

function hasClosingCodeFence(raw: string): boolean {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const opening = lines[0]?.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!opening) return false;

  const marker = opening[1]!;
  return lines.slice(1).some((line) => {
    const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
    return (
      closing !== undefined &&
      closing[0] === marker[0] &&
      closing.length >= marker.length
    );
  });
}

const localMarked = new Marked({
  renderer: {
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
    code({ text, lang, raw }: { text: string; lang?: string; raw: string }) {
      const preClass = hasClosingCodeFence(raw)
        ? ' class="copyable-code-block"'
        : "";
      const langClass = lang ? ` class="language-${lang}"` : "";
      return `<pre${preClass}><code${langClass}>${escapeHtml(text)}</code></pre>`;
    },
    checkbox({ checked }: { checked: boolean }) {
      return renderMarkdownTaskCheckbox(checked);
    },
  },
});

function extractSpecialBlocks(text: string): SpecialBlock[] {
  const specialBlocks: SpecialBlock[] = [];
  SPECIAL_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPECIAL_FENCE_RE.exec(text)) !== null) {
    specialBlocks.push({
      kind: match[1] as SpecialBlock["kind"],
      source: match[2]!,
    });
  }
  return specialBlocks;
}

function parseMarkdown(text: string): {
  html: string;
  specialBlocks: SpecialBlock[];
} {
  const specialBlocks: SpecialBlock[] = [];

  let raw = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SPECIAL_FENCE_RE.lastIndex = 0;
  while ((match = SPECIAL_FENCE_RE.exec(text)) !== null) {
    const [fullMatch, kind, source] = match;
    const start = match.index;
    if (start > lastIndex) {
      raw += localMarked.parse(text.slice(lastIndex, start), {
        async: false,
      }) as string;
    }
    const idx = specialBlocks.length;
    specialBlocks.push({ kind: kind as SpecialBlock["kind"], source });
    raw += renderSpecialBlockContainer(idx, specialBlocks[idx]!);
    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < text.length) {
    raw += localMarked.parse(text.slice(lastIndex), { async: false }) as string;
  }

  // Beyond http(s)/vscode URLs, keep scheme-less hrefs (workspace-relative or
  // absolute file paths, e.g. from `[App.tsx](src/agent/webview/App.tsx)`
  // markdown links) so they can be wired to the host's open-file action. A
  // `path.ext:42` line suffix parses like a URI scheme, so it needs its own
  // allowance; dangerous schemes (javascript:, data:) match none of these.
  const html = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|vscode):|(?![a-z][a-z0-9.+-]*:)|\S*\.\w{1,8}:\d+(?:-\d+)?$)/i,
    ADD_ATTR: ["data-special-idx", "data-special-kind"],
  });

  return { html, specialBlocks };
}

function addCodeBlockCopyButtons(container: HTMLElement) {
  const addCopyButton = (host: HTMLElement, source: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy-button";
    button.title = "Copy code block";
    button.setAttribute("aria-label", "Copy code block");
    button.setAttribute("aria-live", "polite");
    button.innerHTML = '<i class="codicon codicon-copy"></i>';
    button.addEventListener("click", () => {
      navigator.clipboard
        ?.writeText(source)
        .then(() => {
          button.classList.add("copied");
          button.title = "Copied!";
          button.setAttribute("aria-label", "Copied code block");
          button.innerHTML = '<i class="codicon codicon-check"></i>';
          window.setTimeout(() => {
            button.classList.remove("copied");
            button.title = "Copy code block";
            button.setAttribute("aria-label", "Copy code block");
            button.innerHTML = '<i class="codicon codicon-copy"></i>';
          }, 1500);
        })
        .catch(() => {
          // Clipboard access can be unavailable or denied.
        });
    });
    host.appendChild(button);
  };

  container
    .querySelectorAll<HTMLElement>("pre.copyable-code-block")
    .forEach((pre) => {
      const code = pre.querySelector(":scope > code");
      if (!code) return;
      addCopyButton(pre, code.textContent ?? "");
    });

  container
    .querySelectorAll<HTMLElement>(".special-block-container")
    .forEach((specialBlock) => {
      const code = specialBlock.querySelector(".special-block-source > code");
      if (!code) return;
      addCopyButton(specialBlock, code.textContent ?? "");
    });
}

function addExternalLinkFlourishes(container: HTMLElement) {
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    let protocol: string;
    try {
      protocol = new URL(link.href).protocol;
    } catch {
      return;
    }
    if (protocol !== "http:" && protocol !== "https:") return;

    const icon = document.createElement("span");
    icon.className =
      "external-link-flourish codicon codicon-globe external-link-icon";
    icon.setAttribute("aria-hidden", "true");
    link.prepend(icon);
  });
}

function linkifyFilePathNodes(
  container: HTMLElement,
  onOpenFile: (path: string, line?: number) => void,
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== container) {
        const tag = el.tagName;
        if (tag === "CODE" || tag === "PRE" || tag === "A") {
          return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    let lastIndex = 0;
    const parts: Node[] = [];

    for (const match of matchFilePaths(text)) {
      if (match.index > lastIndex) {
        parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = document.createElement("a");
      a.className = "file-path-link";
      a.textContent = match.fullMatch;
      a.href = "#";
      a.title = `Open ${match.filePath}${match.line !== undefined ? `:${match.line}` : ""}`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        onOpenFile(match.filePath, match.line);
      });
      parts.push(a);
      lastIndex = match.index + match.fullMatch.length;
    }

    if (parts.length > 0) {
      if (lastIndex < text.length) {
        parts.push(document.createTextNode(text.slice(lastIndex)));
      }
      const parent = textNode.parentNode;
      if (parent) {
        for (const p of parts) parent.insertBefore(p, textNode);
        parent.removeChild(textNode);
      }
    }
  }
}

// Recognizes `:42` / `:42-51` suffixes and `#L42` / `#L42-L51` fragments on
// markdown link targets that point at workspace files.
const HREF_LINE_SUFFIX_RE = /(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/i;

function parseFileHref(
  href: string,
): { filePath: string; line?: number } | null {
  if (!href || href.startsWith("#")) return null;
  if (/^[a-z][a-z0-9.+-]*:(?!\d+(?:-\d+)?$)/i.test(href)) return null;

  let target = href;
  let line: number | undefined;
  const lineMatch = target.match(HREF_LINE_SUFFIX_RE);
  if (lineMatch) {
    line = parseInt(lineMatch[1] ?? lineMatch[2]!, 10);
    target = target.slice(0, -lineMatch[0].length);
  }
  try {
    target = decodeURI(target);
  } catch {
    // Keep the raw href when it is not valid percent-encoding.
  }
  return target ? { filePath: target, line } : null;
}

function wireFileLinkAnchors(
  container: HTMLElement,
  onOpenFile: (path: string, line?: number) => void,
) {
  container.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    const parsed = parseFileHref(link.getAttribute("href") ?? "");
    if (!parsed) return;
    link.classList.add("file-path-link");
    link.title = `Open ${parsed.filePath}${parsed.line !== undefined ? `:${parsed.line}` : ""}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      onOpenFile(parsed.filePath, parsed.line);
    });
  });
}

function linkifyFilePathCodeSpans(
  container: HTMLElement,
  onOpenFile: (path: string, line?: number) => void,
) {
  container.querySelectorAll<HTMLElement>("code").forEach((code) => {
    if (code.closest("pre, a")) return;
    const text = code.textContent ?? "";
    // Only linkify when the entire code span is one file path — partial
    // matches inside code snippets are too likely to be false positives.
    const [match] = matchFilePaths(` ${text}`);
    if (!match || match.index !== 1 || match.fullMatch.length !== text.length) {
      return;
    }
    const a = document.createElement("a");
    a.className = "file-path-link";
    a.textContent = text;
    a.href = "#";
    a.title = `Open ${match.filePath}${match.line !== undefined ? `:${match.line}` : ""}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onOpenFile(match.filePath, match.line);
    });
    code.textContent = "";
    code.appendChild(a);
  });
}

interface StreamingTextProps {
  text: string;
  streaming: boolean;
  onRevealStart?: () => void;
  onOpenSpecialBlockPanel?: (block: SpecialBlock) => void;
  onOpenFile?: (path: string, line?: number) => void;
}

// Minimum chars to buffer before we start revealing (~1200 chars ≈ a few paragraphs)
const INITIAL_BUFFER = 1200;
// Base chars per frame when we have a large backlog
const MIN_CHARS_PER_FRAME = 1;
// Max chars per frame to catch up when far behind
const MAX_CHARS_PER_FRAME = 6;
// How aggressively to catch up (higher = faster catchup)
const CATCHUP_FACTOR = 0.04;
// Minimum ms between committing reveal progress to state. Each commit re-parses
// the revealed markdown and replaces the container DOM, so committing every rAF
// frame is O(text²) over a message; ~20Hz is visually indistinguishable.
const REVEAL_COMMIT_MS = 48;

export function StreamingText({
  text,
  streaming,
  onRevealStart,
  onOpenSpecialBlockPanel,
  onOpenFile,
}: StreamingTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealedLen, setRevealedLen] = useState(streaming ? 0 : text.length);
  const rafRef = useRef<number>(0);
  const targetLenRef = useRef(text.length);
  const bufferingRef = useRef(streaming);
  const revealStartedRef = useRef(!streaming);
  // Reveal position advances every frame in this ref; it is committed to state
  // (triggering the markdown reparse) at most every REVEAL_COMMIT_MS.
  const revealPosRef = useRef(streaming ? 0 : text.length);
  const lastCommitTimeRef = useRef(0);

  // When not streaming, show everything immediately
  useEffect(() => {
    if (!streaming) {
      revealPosRef.current = text.length;
      setRevealedLen(text.length);
      bufferingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (!revealStartedRef.current) {
        revealStartedRef.current = true;
        onRevealStart?.();
      }
    }
  }, [streaming, text.length, onRevealStart]);

  // Update target length when text grows, end buffering once we have enough
  useEffect(() => {
    targetLenRef.current = text.length;
    if (bufferingRef.current && text.length >= INITIAL_BUFFER) {
      bufferingRef.current = false;
      if (!revealStartedRef.current) {
        revealStartedRef.current = true;
        onRevealStart?.();
      }
    }
  }, [text.length, onRevealStart]);

  // Animate reveal during streaming
  useEffect(() => {
    if (!streaming) return;

    const tick = (now: number) => {
      if (!bufferingRef.current) {
        const target = targetLenRef.current;
        const prev = revealPosRef.current;
        if (prev < target) {
          // Adaptive speed: reveal faster when further behind
          const gap = target - prev;
          const speed = Math.max(
            MIN_CHARS_PER_FRAME,
            Math.min(MAX_CHARS_PER_FRAME, Math.ceil(gap * CATCHUP_FACTOR)),
          );
          revealPosRef.current = Math.min(prev + speed, target);
        }
        const caughtUp = revealPosRef.current >= targetLenRef.current;
        if (caughtUp || now - lastCommitTimeRef.current >= REVEAL_COMMIT_MS) {
          lastCommitTimeRef.current = now;
          setRevealedLen(revealPosRef.current);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [streaming]);

  // Scan the FULL text to get stable special block sources (not affected by
  // reveal animation). Cheap regex scan — no markdown parse needed here.
  const fullSpecialBlocks = useMemo(() => extractSpecialBlocks(text), [text]);
  const specialBlocksRef = useRef<SpecialBlock[]>([]);
  specialBlocksRef.current = fullSpecialBlocks;

  // Parse the revealed portion for display
  const displayText = streaming ? text.slice(0, revealedLen) : text;
  const parsed = useMemo(() => parseMarkdown(displayText), [displayText]);

  // Track which special block indices have been rendered (survives across re-renders)
  const renderedSpecialBlocksRef = useRef<Set<number>>(new Set());
  // Track in-flight renders to avoid duplicates
  const renderingSpecialBlocksRef = useRef<Set<number>>(new Set());

  // Reset when the underlying text changes (new message)
  useEffect(() => {
    renderedSpecialBlocksRef.current.clear();
    renderingSpecialBlocksRef.current.clear();
  }, [text]);

  // Update DOM
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = parsed.html;

    addCodeBlockCopyButtons(containerRef.current);
    addExternalLinkFlourishes(containerRef.current);

    // Wire markdown links whose targets are workspace file paths, linkify
    // whole-path inline code spans, and linkify bare file paths in text nodes
    // (skips fenced code blocks).
    if (onOpenFile) {
      wireFileLinkAnchors(containerRef.current, onOpenFile);
      linkifyFilePathCodeSpans(containerRef.current, onOpenFile);
      linkifyFilePathNodes(containerRef.current, onOpenFile);
    }

    // Re-stamp already-rendered diagrams — their SVGs were lost when innerHTML was reset
    // We cache rendered SVGs so we can restore them instantly
    containerRef.current
      .querySelectorAll(".special-block-container[data-special-idx]")
      .forEach((el) => {
        const idx = parseInt(el.getAttribute("data-special-idx") ?? "", 10);
        const cached = specialBlockHtmlCache.current.get(idx);
        if (cached !== undefined) {
          const renderEl = el.querySelector(
            ".special-block-render",
          ) as HTMLElement;
          if (renderEl) renderEl.innerHTML = cached;
        }
      });

    containerRef.current
      .querySelectorAll(".special-block-toggle-code")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const container = btn.closest(".special-block-container");
          if (!container) return;
          const sourceEl = container.querySelector(
            ".special-block-source",
          ) as HTMLElement;
          if (!sourceEl) return;
          const hidden = sourceEl.style.display === "none";
          sourceEl.style.display = hidden ? "block" : "none";
          btn.textContent = hidden ? "Hide Code" : "Show Code";
        });
      });

    containerRef.current
      .querySelectorAll(".special-block-popout")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const container = btn.closest(".special-block-container");
          if (!container) return;
          const idx = parseInt(
            container.getAttribute("data-special-idx") ?? "",
            10,
          );
          const block = Number.isFinite(idx)
            ? specialBlocksRef.current[idx]
            : null;
          if (!block) return;
          onOpenSpecialBlockPanel?.(block);
        });
      });
  }, [parsed.html, onOpenSpecialBlockPanel, onOpenFile]);

  // Cache for rendered output — survives innerHTML resets
  const specialBlockHtmlCache = useRef<Map<number, string>>(new Map());

  // Reset cache when text changes
  useEffect(() => {
    specialBlockHtmlCache.current.clear();
  }, [text]);

  // Render special blocks as their code fences complete
  useEffect(() => {
    if (!containerRef.current) return;
    if (parsed.specialBlocks.length === 0) return;

    const containers = containerRef.current.querySelectorAll(
      ".special-block-container[data-special-idx]",
    );
    if (containers.length === 0) return;

    const currentContainer = containerRef.current;

    containers.forEach(async (el) => {
      const idx = parseInt(el.getAttribute("data-special-idx") ?? "", 10);
      if (renderedSpecialBlocksRef.current.has(idx)) return;
      if (renderingSpecialBlocksRef.current.has(idx)) return;

      const block = specialBlocksRef.current[idx];
      const revealedBlock = parsed.specialBlocks[idx];
      if (!block || revealedBlock === undefined) return;

      renderingSpecialBlocksRef.current.add(idx);

      const renderEl = el.querySelector(".special-block-render") as HTMLElement;
      if (!renderEl) return;

      try {
        let renderedHtml: string;
        if (block.kind === "mermaid") {
          const { renderMermaid } = await loadMermaidRenderer();
          renderedHtml = await renderMermaid(
            block.source,
            `mermaid-${Date.now()}-${idx}`,
          );
        } else {
          const { renderVega } = await loadVegaRenderer();
          renderedHtml = await renderVega(block.source, block.kind);
        }

        renderedSpecialBlocksRef.current.add(idx);
        renderingSpecialBlocksRef.current.delete(idx);
        specialBlockHtmlCache.current.set(idx, renderedHtml);
        if (currentContainer === containerRef.current) {
          renderEl.innerHTML = renderedHtml;
        }
      } catch (err) {
        renderedSpecialBlocksRef.current.add(idx);
        renderingSpecialBlocksRef.current.delete(idx);
        const errMsg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Unknown error";
        const label = block.kind === "mermaid" ? "diagram" : "chart";
        console.error(`[${block.kind}] Failed to render ${label} ${idx}:`, err);
        const errorHtml = `<span class="special-block-error">Failed to render ${label}: ${escapeHtml(errMsg)}</span>`;
        specialBlockHtmlCache.current.set(idx, errorHtml);
        if (currentContainer === containerRef.current) {
          renderEl.innerHTML = errorHtml;
        }
      }
    });
  }, [parsed.html, parsed.specialBlocks]);

  return <div ref={containerRef} class="markdown-body" />;
}
