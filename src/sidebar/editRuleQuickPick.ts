import * as vscode from "vscode";

interface ModeItem<TMode extends string> extends vscode.QuickPickItem {
  mode: TMode;
  alwaysShow: true;
}

/**
 * Shared QuickPick helper for editing approval rules.
 *
 * Shows a QuickPick with an editable pattern field and selectable match mode.
 * Returns the user's chosen pattern + mode, or null if cancelled.
 */
export async function editRuleViaQuickPick<TMode extends string>(opts: {
  oldPattern: string;
  oldMode: string;
  title: string;
  modes: ModeItem<TMode>[];
}): Promise<{ pattern: string; mode: TMode } | null> {
  const qp = vscode.window.createQuickPick<ModeItem<TMode>>();
  qp.title = opts.title;
  qp.placeholder = "Edit the pattern above, then select match mode";
  qp.value = opts.oldPattern;
  qp.items = opts.modes;

  const current = opts.modes.find((m) => m.mode === opts.oldMode);
  if (current) qp.activeItems = [current];
  qp.ignoreFocusOut = true;

  const result = await new Promise<{
    pattern: string;
    mode: TMode;
  } | null>((resolve) => {
    let resolved = false;
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected && qp.value.trim()) {
        resolved = true;
        resolve({ pattern: qp.value.trim(), mode: selected.mode });
        qp.dispose();
      }
    });
    qp.onDidHide(() => {
      if (!resolved) resolve(null);
      qp.dispose();
    });
    qp.show();
  });

  return result;
}
