import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import type { CommandRule, PathRule } from "./ApprovalManager.js";

export interface NativeClaudeConfig {
  version: number;
  writeApproved?: boolean;
  commandRules?: CommandRule[];
  pathRules?: PathRule[];
  writeRules?: PathRule[];
}

const EMPTY_CONFIG: NativeClaudeConfig = { version: 1 };
const GLOBAL_DIR = path.join(os.homedir(), ".claude");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_DIR, "native-claude.json");
const PROJECT_CONFIG_RELATIVE = path.join(".claude", "native-claude.json");
const DEBOUNCE_MS = 200;

function log(msg: string): void {
  const ch = vscode.window.createOutputChannel("native-claude", { log: true });
  ch.info(msg);
}

export class ConfigStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private globalConfig: NativeClaudeConfig = { ...EMPTY_CONFIG };
  private projectConfigs = new Map<string, NativeClaudeConfig>();

  private globalWatcher: fs.FSWatcher | null = null;
  private projectWatcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.loadGlobalConfig();
    this.loadProjectConfigs();
    this.startWatching();
  }

  // --- Public API ---

  getGlobalConfig(): Readonly<NativeClaudeConfig> {
    return this.globalConfig;
  }

  updateGlobalConfig(updater: (config: NativeClaudeConfig) => void): boolean {
    const config = structuredClone(this.globalConfig);
    updater(config);
    if (this.writeConfig(GLOBAL_CONFIG_PATH, config)) {
      this.globalConfig = config;
      this._onDidChange.fire();
      return true;
    }
    return false;
  }

  getProjectConfig(workspaceFolder: string): Readonly<NativeClaudeConfig> {
    return this.projectConfigs.get(workspaceFolder) ?? { ...EMPTY_CONFIG };
  }

  updateProjectConfig(
    workspaceFolder: string,
    updater: (config: NativeClaudeConfig) => void,
  ): boolean {
    const config = structuredClone(
      this.projectConfigs.get(workspaceFolder) ?? { ...EMPTY_CONFIG },
    );
    updater(config);
    const configPath = path.join(workspaceFolder, PROJECT_CONFIG_RELATIVE);
    if (this.writeConfig(configPath, config)) {
      this.projectConfigs.set(workspaceFolder, config);
      this._onDidChange.fire();
      return true;
    }
    return false;
  }

  /**
   * Get the project config for the first workspace root, or null if no workspace is open.
   */
  getProjectConfigForFirstRoot(): Readonly<NativeClaudeConfig> | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return this.getProjectConfig(folders[0].uri.fsPath);
  }

  dispose(): void {
    if (this.globalWatcher) {
      this.globalWatcher.close();
      this.globalWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.projectWatcher?.dispose();
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }

  // --- Private: Read/Write ---

  private loadGlobalConfig(): void {
    this.globalConfig = this.readConfig(GLOBAL_CONFIG_PATH);
  }

  private loadProjectConfigs(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;
    for (const folder of folders) {
      const configPath = path.join(folder.uri.fsPath, PROJECT_CONFIG_RELATIVE);
      this.projectConfigs.set(folder.uri.fsPath, this.readConfig(configPath));
    }
  }

  private readConfig(filePath: string): NativeClaudeConfig {
    try {
      if (!fs.existsSync(filePath)) return { ...EMPTY_CONFIG };
      const raw = fs.readFileSync(filePath, "utf-8");
      return this.parseAndValidate(raw, filePath);
    } catch (err) {
      log(`Warning: Could not read config ${filePath}: ${err}`);
      return { ...EMPTY_CONFIG };
    }
  }

  private writeConfig(filePath: string, config: NativeClaudeConfig): boolean {
    const dir = path.dirname(filePath);
    const tmpPath = filePath + ".tmp." + process.pid;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(config, null, 2) + "\n",
        "utf-8",
      );
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch (err) {
      log(`Warning: Could not write config ${filePath}: ${err}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      return false;
    }
  }

  private parseAndValidate(raw: string, filePath: string): NativeClaudeConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log(`Warning: Malformed JSON in ${filePath}, treating as empty config`);
      vscode.window
        .showWarningMessage(
          `native-claude: Invalid JSON in ${filePath}`,
          "Open File",
        )
        .then((choice) => {
          if (choice === "Open File") {
            vscode.window.showTextDocument(vscode.Uri.file(filePath));
          }
        });
      return { ...EMPTY_CONFIG };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      log(`Warning: Config ${filePath} is not an object, treating as empty`);
      return { ...EMPTY_CONFIG };
    }

    const obj = parsed as Record<string, unknown>;
    const config: NativeClaudeConfig = {
      version: typeof obj.version === "number" ? obj.version : 1,
    };

    if (typeof obj.writeApproved === "boolean") {
      config.writeApproved = obj.writeApproved;
    }

    if (Array.isArray(obj.commandRules)) {
      config.commandRules = obj.commandRules.filter(
        (r): r is CommandRule =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as CommandRule).pattern === "string" &&
          ["prefix", "regex", "exact"].includes((r as CommandRule).mode),
      );
    }

    if (Array.isArray(obj.pathRules)) {
      config.pathRules = obj.pathRules.filter(
        (r): r is PathRule =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as PathRule).pattern === "string" &&
          ["glob", "prefix", "exact"].includes((r as PathRule).mode),
      );
    }

    if (Array.isArray(obj.writeRules)) {
      config.writeRules = obj.writeRules.filter(
        (r): r is PathRule =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as PathRule).pattern === "string" &&
          ["glob", "prefix", "exact"].includes((r as PathRule).mode),
      );
    }

    return config;
  }

  // --- Private: File Watching ---

  private startWatching(): void {
    // Watch global config with fs.watch (outside workspace)
    try {
      if (fs.existsSync(GLOBAL_DIR)) {
        this.globalWatcher = fs.watch(GLOBAL_DIR, (eventType, filename) => {
          if (filename === "native-claude.json") {
            this.debouncedReload("global");
          }
        });
        this.globalWatcher.on("error", () => {
          // Silently ignore watch errors
        });
      }
    } catch {
      // fs.watch not available, skip
    }

    // Watch project configs with VS Code file system watcher
    this.projectWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.claude/native-claude.json",
    );
    this.projectWatcher.onDidChange(() => this.debouncedReload("project"));
    this.projectWatcher.onDidCreate(() => this.debouncedReload("project"));
    this.projectWatcher.onDidDelete(() => this.debouncedReload("project"));
    this.disposables.push(this.projectWatcher);

    // Watch for workspace folder changes
    const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.loadProjectConfigs();
      this._onDidChange.fire();
    });
    this.disposables.push(folderListener);
  }

  private debouncedReload(scope: "global" | "project"): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (scope === "global") {
        this.loadGlobalConfig();
      } else {
        this.loadProjectConfigs();
      }
      this._onDidChange.fire();
    }, DEBOUNCE_MS);
  }
}
