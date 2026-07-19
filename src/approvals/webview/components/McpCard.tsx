import type { ApprovalRequest, DecisionMessage } from "../types.js";

import { ApprovalLayout } from "./ApprovalLayout.js";
import type { RefObject } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

interface McpCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

/**
 * Rich approval card for MCP tool invocations.
 * Shows the tool title, input preview, and approval choices.
 */
export function McpCard({ request, submit, followUpRef }: McpCardProps) {
  const detail = request.mcpDetail;
  const choices = request.mcpChoices ?? [];
  const titleMatch = request.command?.match(
    /Allow MCP tool "([^"]+)" from "([^"]+)"/,
  );
  const toolName = request.mcpToolName ?? titleMatch?.[1] ?? "MCP tool";
  const serverName = request.mcpServerName ?? titleMatch?.[2] ?? "MCP server";

  const primaryChoice = choices.find((c) => c.isPrimary);
  const denyChoice = choices.find((c) => c.isDanger);
  const allowedChoices = choices.filter((choice) => !choice.isDanger);
  const initialDecision = primaryChoice?.value ?? "allow-once";
  const [selectedDecision, setSelectedDecision] = useState(initialDecision);

  useEffect(() => {
    setSelectedDecision(initialDecision);
  }, [request.id, initialDecision]);

  const selectedChoice =
    allowedChoices.find((choice) => choice.value === selectedDecision) ??
    primaryChoice;
  const sessionChoices = allowedChoices.filter((choice) =>
    ["always-tool-session", "always-server-session"].includes(choice.value),
  );
  const durableChoices = allowedChoices.filter((choice) =>
    [
      "always-tool-project",
      "always-tool-global",
      "always-server-project",
      "always-server-global",
    ].includes(choice.value),
  );
  const otherChoices = allowedChoices.filter(
    (choice) =>
      choice.value !== initialDecision &&
      !sessionChoices.includes(choice) &&
      !durableChoices.includes(choice),
  );
  const selectedIsEntireServer = selectedDecision.startsWith("always-server-");

  const getChoiceCopy = (value: string, fallbackLabel: string) => {
    switch (value) {
      case "allow-once":
        return {
          title: "Run once",
          description: "Approve only this call. Ask again next time.",
          action: "Run tool once",
          icon: "play",
        };
      case "always-tool-session":
        return {
          title: "This tool for this session",
          description: `Run ${toolName} again in this chat without asking.`,
          action: "Allow tool for session",
          icon: "tools",
        };
      case "always-server-session":
        return {
          title: `Entire ${serverName} MCP for this session`,
          description: `Run any tool from ${serverName} in this chat without asking.`,
          action: "Allow MCP for session",
          icon: "server",
        };
      case "always-tool-project":
        return {
          title: "This tool for this project",
          description: `Allow ${toolName} in future chats for this project.`,
          action: "Always allow tool in project",
          icon: "root-folder",
        };
      case "always-server-project":
        return {
          title: `Entire ${serverName} MCP for this project`,
          description: `Allow every ${serverName} tool in future chats for this project.`,
          action: "Always allow MCP in project",
          icon: "root-folder",
        };
      case "always-tool-global":
        return {
          title: "This tool everywhere",
          description: `Allow ${toolName} in every project and chat.`,
          action: "Always allow tool everywhere",
          icon: "globe",
        };
      case "always-server-global":
        return {
          title: `Entire ${serverName} MCP everywhere`,
          description: `Allow every ${serverName} tool in every project and chat.`,
          action: "Always allow MCP everywhere",
          icon: "globe",
        };
      default:
        return {
          title: fallbackLabel,
          description: "Use this permission for the current request.",
          action: fallbackLabel,
          icon: "key",
        };
    }
  };

  const renderChoice = (choice: (typeof choices)[number]) => {
    const copy = getChoiceCopy(choice.value, choice.label);
    const descriptionId = `${request.id}-${choice.value}-description`;
    return (
      <label
        key={choice.value}
        class={`mcp-permission-option${
          selectedDecision === choice.value ? " selected" : ""
        }${choice.value.startsWith("always-server-") ? " broad" : ""}`}
      >
        <input
          type="radio"
          name={`mcp-permission-${request.id}`}
          value={choice.value}
          checked={selectedDecision === choice.value}
          aria-describedby={descriptionId}
          onChange={() => setSelectedDecision(choice.value)}
        />
        <span class={`codicon codicon-${copy.icon} mcp-permission-icon`} />
        <span class="mcp-permission-copy">
          <span class="mcp-permission-title">{copy.title}</span>
          <span class="mcp-permission-description" id={descriptionId}>
            {copy.description}
          </span>
        </span>
        {choice.value === "always-server-session" && (
          <span class="mcp-new-choice-badge">New</span>
        )}
      </label>
    );
  };

  const handleAccept = useCallback(() => {
    submit({
      id: request.id,
      decision: selectedChoice?.value ?? "allow-once",
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, selectedChoice, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({
        id: request.id,
        decision: denyChoice?.value ?? "deny",
        rejectionReason: reason,
      });
    },
    [request.id, denyChoice, submit],
  );

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      sourceProject={request.sourceProject}
      targetProject={request.targetProject}
      purpose={`Run ${toolName} from ${serverName}`}
      rulesContent={null}
      rulesModified={false}
      primaryLabel={
        getChoiceCopy(
          selectedChoice?.value ?? "allow-once",
          selectedChoice?.label ?? "Allow",
        ).action
      }
      primaryWithRulesLabel=""
      onAccept={handleAccept}
      onSaveAndAccept={handleAccept}
      onReject={handleReject}
      followUpRef={followUpRef}
      followUpLabel="Message to the agent (optional)"
      followUpPlaceholder="Add guidance for this call, or explain why you’re denying it..."
      rejectLabel="Deny"
    >
      <div class="mcp-identity-card">
        <div class="mcp-identity-icon" aria-hidden="true">
          <span class="codicon codicon-server" />
        </div>
        <div class="mcp-identity-copy">
          <span class="mcp-identity-eyebrow">External MCP request</span>
          <div class="mcp-identity-route">
            <span>{serverName}</span>
            <span class="codicon codicon-chevron-right" aria-hidden="true" />
            <code>{toolName}</code>
          </div>
        </div>
        <span class="mcp-external-badge">External</span>
      </div>

      {detail && (
        <details class="mcp-input-disclosure" open>
          <summary>
            <span class="codicon codicon-json" /> Request input
          </summary>
          <pre>{detail}</pre>
        </details>
      )}

      <fieldset class="mcp-permission-fieldset">
        <legend>Choose what to allow</legend>
        {primaryChoice && renderChoice(primaryChoice)}

        {sessionChoices.length > 0 && (
          <div class="mcp-permission-group">
            <div class="mcp-permission-group-heading">
              <span>Remember in this chat</span>
              <span class="mcp-session-badge">Session only</span>
            </div>
            <p>Cleared when this chat session ends.</p>
            <div class="mcp-permission-options">
              {sessionChoices.map(renderChoice)}
            </div>
          </div>
        )}

        {selectedIsEntireServer && (
          <div class="mcp-scope-warning" role="status">
            <span class="codicon codicon-shield" aria-hidden="true" />
            <span>
              This skips future prompts for <strong>every tool</strong> exposed
              by {serverName} at the selected scope.
            </span>
          </div>
        )}

        {durableChoices.length > 0 && (
          <details
            class="mcp-durable-permissions"
            open={durableChoices.some(
              (choice) => choice.value === selectedDecision,
            )}
          >
            <summary>
              <span class="codicon codicon-settings-gear" /> Project &amp;
              global permissions
            </summary>
            <p class="mcp-durable-note">
              These choices update MCP configuration and remain after this
              session.
            </p>
            <div class="mcp-permission-options">
              {durableChoices.map(renderChoice)}
            </div>
          </details>
        )}

        {otherChoices.length > 0 && (
          <div class="mcp-permission-options">
            {otherChoices.map(renderChoice)}
          </div>
        )}
      </fieldset>
    </ApprovalLayout>
  );
}
