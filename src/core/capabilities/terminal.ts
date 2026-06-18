export interface TerminalCommandResult {
  exit_code: number | null;
  output: string;
  cwd?: string;
  output_captured: boolean;
  terminal_id: string;
  terminal_name?: string;
  output_file?: string;
  output_warning?: string;
  terminal_raw_output?: string;
  total_lines?: number;
  lines_shown?: number;
  command?: string;
  command_template?: string;
  command_modified?: boolean;
  original_command?: string;
  inline_files?: Array<{ name: string; bytes: number; sha256: string }>;
  follow_up?: string;
  approval?:
    | { by: "master_bypass" }
    | { by: "explicit_rule" }
    | { by: "recent_approval" }
    | {
        by: "tier";
        tier: "safe" | "sensitive" | "dangerous";
        threshold: "safe" | "sensitive";
      }
    | { by: "human" }
    | { by: "human_edited" };
  auto_approved?: {
    by: "tier";
    tier: "safe" | "sensitive" | "dangerous";
    threshold: "safe" | "sensitive";
  };
  timed_out?: boolean;
  execution_mode?: "shell_integration" | "send_text";
  verification_hint?: string;
  command_sent?: boolean;
}

export interface TerminalExecuteOptions {
  command: string;
  cwd: string;
  terminal_id?: string;
  terminal_name?: string;
  split_from?: string;
  background?: boolean;
  timeout?: number;
  env?: Record<string, string>;
  onTerminalAssigned?: (terminalId: string) => void;
}

export interface TerminalBackgroundState {
  is_running: boolean;
  exit_code: number | null;
  output: string;
  output_captured: boolean;
  terminal_raw_output?: string;
}

export interface ClosedTerminalSnapshot {
  id: string;
  name: string;
  closedAt: number;
}

export interface TerminalMetadata {
  id: string;
  name: string;
  busy: boolean;
  stale?: boolean;
}

export interface TerminalCloseResult {
  closed: number;
  not_found?: string[];
}

export interface TerminalProvider {
  executeCommand(
    options: TerminalExecuteOptions,
  ): Promise<TerminalCommandResult>;
  getBackgroundState(terminalId: string): TerminalBackgroundState | undefined;
  interruptTerminal(terminalId: string): boolean;
  getRecentlyClosedTerminals(limit?: number): ClosedTerminalSnapshot[];
  listTerminals(): TerminalMetadata[];
  closeTerminals(names?: string[]): TerminalCloseResult;
  log?(message: string): void;
}
