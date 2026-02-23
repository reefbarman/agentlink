import * as vscode from "vscode";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export async function handleShowNotification(params: {
  message: string;
  type?: "info" | "warning" | "error";
}): Promise<ToolResult> {
  const type = params.type ?? "info";

  switch (type) {
    case "warning":
      vscode.window.showWarningMessage(params.message);
      break;
    case "error":
      vscode.window.showErrorMessage(params.message);
      break;
    default:
      vscode.window.showInformationMessage(params.message);
      break;
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ status: "shown", type, message: params.message }) }],
  };
}
