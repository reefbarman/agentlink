import type * as MonacoApi from "./browserMonaco";

import type { BrowserGatewayThemeSnapshot } from "@agentlink/protocol/browser-gateway-theme";

/**
 * Lazy loading and theming for the browser's read-only Monaco editors (the
 * diff viewer and the file viewer). Monaco is a separate bundle served at
 * /browser-gateway-monaco.js; the build keeps this module's
 * `import("./browserMonaco")` external, so keep that import here.
 */

export type MonacoModule = typeof MonacoApi;

type MonacoThemeColorKey = Parameters<
  MonacoModule["editor"]["defineTheme"]
>[1]["colors"] extends infer Colors
  ? keyof NonNullable<Colors>
  : string;

const MONACO_THEME_NAME = "agentlink-browser-gateway";

let monacoPromise: Promise<MonacoModule> | null = null;
let monacoStylesheetPromise: Promise<void> | null = null;
let monacoWorkersConfigured = false;

function loadMonacoStylesheet(): Promise<void> {
  if (monacoStylesheetPromise) return monacoStylesheetPromise;
  monacoStylesheetPromise = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/browser-gateway-monaco.css";
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener(
      "error",
      () => {
        link.remove();
        reject(new Error("browser_monaco_stylesheet_load_failed"));
      },
      { once: true },
    );
    document.head.appendChild(link);
  }).catch((error: unknown) => {
    monacoStylesheetPromise = null;
    throw error;
  });
  return monacoStylesheetPromise;
}

export function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = Promise.all([
      loadMonacoStylesheet(),
      import("./browserMonaco"),
    ])
      .then(([, monaco]) => monaco)
      .catch((error: unknown) => {
        monacoPromise = null;
        throw error;
      });
  }
  return monacoPromise;
}

export function configureMonacoWorkers(): void {
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

export function inferLanguageId(filePath: string): string {
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

export function defineTheme(
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
