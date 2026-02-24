import * as vscode from "vscode";

/**
 * Singleton FIFO queue that serializes QuickPick/InputBox approval dialogs.
 *
 * VS Code only allows one QuickPick at a time — showing a second hides the
 * first, triggering its onDidHide (which typically auto-rejects). When
 * multiple MCP tool calls arrive concurrently and each needs user approval,
 * this queue ensures they are shown one at a time.
 */

interface QueueEntry<T = unknown> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

const queue: QueueEntry[] = [];
let running = false;

let statusBar: vscode.StatusBarItem | undefined;

function getStatusBar(): vscode.StatusBarItem {
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      9999, // Just below the approval alert at 10000
    );
    statusBar.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }
  return statusBar;
}

function updatePendingCount(): void {
  const pending = queue.length;
  const bar = getStatusBar();
  if (pending > 0) {
    bar.text = `$(ellipsis) ${pending} more approval${pending > 1 ? "s" : ""} pending`;
    bar.show();
  } else {
    bar.hide();
  }
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const entry = queue.shift()!;
    updatePendingCount();
    try {
      const result = await entry.run();
      entry.resolve(result);
    } catch (err) {
      entry.reject(err);
    }
  }

  running = false;
  updatePendingCount();
}

/**
 * Enqueue an approval dialog. The `showFn` callback is invoked when it's
 * this entry's turn — it should create/show the QuickPick and return a
 * promise that resolves when the user makes their decision.
 *
 * The queue advances only after the promise resolves (or rejects).
 * Include follow-up dialogs (pattern editors, rejection reason prompts)
 * inside the same callback to prevent them from colliding with the next
 * queued approval.
 */
export function enqueueApproval<T>(
  label: string,
  showFn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      label,
      run: showFn as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    updatePendingCount();
    processQueue();
  });
}

/** Dispose the pending-count status bar item on extension deactivation. */
export function disposeQuickPickQueue(): void {
  statusBar?.dispose();
  statusBar = undefined;
}
