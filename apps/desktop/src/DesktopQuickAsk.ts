import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type WebContents,
} from "electron";
import type {
  DesktopQuickAskMedia,
  DesktopQuickAskSubmission,
} from "../../../src/shared/desktopBridge.js";
import {
  DEFAULT_QUICK_ASK_SHORTCUT,
  isValidQuickAskAccelerator,
} from "./quickAskShortcut.js";
import {
  readDesktopPreferences,
  updateDesktopPreferences,
} from "./desktopPreferences.js";

export const QUICK_ASK_PANEL_WIDTH = 760;
export const QUICK_ASK_PANEL_HEIGHT = 520;
// The composer is anchored to the bottom of a transparent panel so the model
// and thinking menus have room to open upward. Put that bottom edge a little
// above the middle of the screen.
const PANEL_BOTTOM_RATIO = 0.55;
const MAX_TEXT_CHARS = 200_000;
const MAX_MEDIA_ITEMS = 20;
const MAX_MEDIA_BASE64_CHARS = 64 * 1024 * 1024;

export interface QuickAskShortcutStatus {
  shortcut: string | null;
  registered: boolean;
  defaultShortcut: string;
}

export interface DesktopQuickAskOptions {
  preferencesPath: string;
  /** Creates and loads the panel window. */
  createWindow(): Promise<BrowserWindow>;
  /** Brings the main chat window forward and returns its contents. */
  openChat(): Promise<WebContents | null>;
  /** Whether the Ask Agent is ready; otherwise setup is shown instead. */
  canAsk(): Promise<boolean>;
  openSetup(): void;
  onShortcutChanged(): void;
  log(message: string): void;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength
    ? value
    : undefined;
}

/** Validates an untrusted renderer submission; returns null when unusable. */
export function normalizeQuickAskSubmission(
  raw: unknown,
): DesktopQuickAskSubmission | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== "string" || value.text.length > MAX_TEXT_CHARS) {
    return null;
  }
  const media: DesktopQuickAskMedia[] = [];
  if (value.media !== undefined) {
    if (!Array.isArray(value.media) || value.media.length > MAX_MEDIA_ITEMS) {
      return null;
    }
    let totalChars = 0;
    for (const item of value.media as unknown[]) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const name = optionalString(entry.name, 1_000);
      const mimeType = optionalString(entry.mimeType, 200);
      if (
        name === undefined ||
        mimeType === undefined ||
        typeof entry.base64 !== "string" ||
        (entry.kind !== "image" && entry.kind !== "document")
      ) {
        return null;
      }
      totalChars += entry.base64.length;
      if (totalChars > MAX_MEDIA_BASE64_CHARS) return null;
      media.push({ name, mimeType, base64: entry.base64, kind: entry.kind });
    }
  }
  if (!value.text.trim() && media.length === 0) return null;
  const displayText = optionalString(value.displayText, MAX_TEXT_CHARS);
  const slashCommandLabel = optionalString(value.slashCommandLabel, 200);
  return {
    text: value.text,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(slashCommandLabel !== undefined ? { slashCommandLabel } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

/**
 * Owns the system-wide quick-ask shortcut and its floating composer panel.
 * Sent messages are queued here until the main chat window drains them, so a
 * hand-off survives the chat window still loading.
 */
export class DesktopQuickAsk {
  private window: BrowserWindow | null = null;
  private windowPromise: Promise<BrowserWindow> | null = null;
  private pending: DesktopQuickAskSubmission[] = [];
  private chatContentsId: number | null = null;
  private shortcut: string | null = DEFAULT_QUICK_ASK_SHORTCUT;
  private registered = false;

  constructor(private readonly options: DesktopQuickAskOptions) {}

  async initialize(): Promise<void> {
    this.registerIpc();
    const configured = (
      await readDesktopPreferences(this.options.preferencesPath)
    ).quickAskShortcut;
    this.shortcut =
      configured === null
        ? null
        : isValidQuickAskAccelerator(configured)
          ? configured
          : DEFAULT_QUICK_ASK_SHORTCUT;
    if (this.shortcut) {
      this.registered = this.register(this.shortcut);
      if (!this.registered) {
        this.options.log(
          `quick ask shortcut ${this.shortcut} is unavailable; another app may be using it`,
        );
      }
    }
  }

  getShortcutStatus(): QuickAskShortcutStatus {
    return {
      shortcut: this.shortcut,
      registered: this.registered,
      defaultShortcut: DEFAULT_QUICK_ASK_SHORTCUT,
    };
  }

  async setShortcut(next: string | null): Promise<QuickAskShortcutStatus> {
    if (next !== null && !isValidQuickAskAccelerator(next)) {
      throw new Error("invalid_shortcut");
    }
    const previous = this.shortcut;
    if (next === previous && (next === null || this.registered)) {
      return this.getShortcutStatus();
    }
    if (previous && this.registered) globalShortcut.unregister(previous);
    if (next && !this.register(next)) {
      this.registered = previous ? this.register(previous) : false;
      throw new Error("shortcut_unavailable");
    }
    this.shortcut = next;
    this.registered = next !== null;
    await updateDesktopPreferences(this.options.preferencesPath, {
      quickAskShortcut: next,
    });
    this.options.onShortcutChanged();
    return this.getShortcutStatus();
  }

  getPanelContents(): WebContents | null {
    const contents = this.window?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  /** Loads the panel in the background so the first shortcut press is instant. */
  prewarm(): void {
    void this.ensureWindow().catch((error) =>
      this.options.log(`quick ask prewarm failed: ${String(error)}`),
    );
  }

  async toggle(): Promise<void> {
    const window = this.window;
    if (window && !window.isDestroyed() && window.isVisible()) {
      this.hide();
      return;
    }
    await this.show();
  }

  async show(): Promise<void> {
    if (!(await this.options.canAsk())) {
      this.options.openSetup();
      return;
    }
    const window = await this.ensureWindow();
    const { workArea } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const width = Math.min(QUICK_ASK_PANEL_WIDTH, workArea.width - 32);
    const height = Math.min(QUICK_ASK_PANEL_HEIGHT, workArea.height);
    const bottom =
      workArea.y + Math.round(workArea.height * PANEL_BOTTOM_RATIO);
    window.setBounds({
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.max(workArea.y, bottom - height),
      width,
      height,
    });
    window.show();
    window.focus();
    window.webContents.focus();
    window.webContents.send("agentlink:quick-ask:shown");
  }

  hide(): void {
    const window = this.window;
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.registered = false;
  }

  private register(accelerator: string): boolean {
    try {
      return globalShortcut.register(accelerator, () => {
        void this.toggle().catch((error) =>
          this.options.log(`quick ask failed: ${String(error)}`),
        );
      });
    } catch (error) {
      this.options.log(`quick ask shortcut rejected: ${String(error)}`);
      return false;
    }
  }

  private ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      return Promise.resolve(this.window);
    }
    this.windowPromise ??= this.options
      .createWindow()
      .then((window) => {
        this.window = window;
        window.on("blur", () => this.hide());
        window.on("closed", () => {
          if (this.window === window) this.window = null;
          this.windowPromise = null;
        });
        return window;
      })
      .catch((error: unknown) => {
        this.windowPromise = null;
        throw error;
      });
    return this.windowPromise;
  }

  private isPanelSender(sender: WebContents): boolean {
    return this.getPanelContents()?.id === sender.id;
  }

  private registerIpc(): void {
    ipcMain.on("agentlink:quick-ask:submit", (event, raw: unknown) => {
      if (!this.isPanelSender(event.sender)) return;
      const submission = normalizeQuickAskSubmission(raw);
      if (!submission) {
        this.options.log("quick ask submission rejected");
        return;
      }
      this.pending.push(submission);
      this.hide();
      void this.deliver();
    });
    ipcMain.on("agentlink:quick-ask:dismiss", (event) => {
      if (this.isPanelSender(event.sender)) this.hide();
    });
    ipcMain.handle("agentlink:quick-ask:take", (event) => {
      if (event.sender.id !== this.chatContentsId) return [];
      return this.pending.splice(0);
    });
  }

  private async deliver(): Promise<void> {
    try {
      const contents = await this.options.openChat();
      if (!contents || contents.isDestroyed()) {
        this.options.log("quick ask delivery failed: chat window unavailable");
        return;
      }
      this.chatContentsId = contents.id;
      contents.send("agentlink:quick-ask:available");
    } catch (error) {
      this.options.log(`quick ask delivery failed: ${String(error)}`);
    }
  }
}
