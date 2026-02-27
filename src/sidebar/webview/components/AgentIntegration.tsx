import { useState } from "preact/hooks";
import type { SidebarState, PostCommand, AgentInfo } from "../types.js";
import { CollapsibleSection } from "./common/CollapsibleSection.js";

interface Props {
  state: SidebarState;
  postCommand: PostCommand;
}

// --- Per-agent verification & setup info ---

interface AgentNextSteps {
  verify: string;
  supportsInstructionSetup: boolean;
  supportsHooks: boolean;
  instructionTarget: string;
}

const AGENT_NEXT_STEPS: Record<string, AgentNextSteps> = {
  "claude-code": {
    verify:
      'Run "claude mcp list" in your terminal — you should see "agentlink" in the output.',
    supportsInstructionSetup: true,
    supportsHooks: true,
    instructionTarget: "~/.claude/CLAUDE.md",
  },
  copilot: {
    verify:
      "Reload VS Code, then open Copilot Chat — it should detect the MCP server from .vscode/mcp.json.",
    supportsInstructionSetup: true,
    supportsHooks: true,
    instructionTarget: ".github/copilot-instructions.md",
  },
  "roo-code": {
    verify:
      'Restart Roo Code. Check Settings → MCP Servers — "agentlink" should appear.',
    supportsInstructionSetup: true,
    supportsHooks: false,
    instructionTarget: ".roo/rules/agentlink.md",
  },
  cline: {
    verify:
      'Restart Cline. Check MCP Servers in settings — "agentlink" should appear.',
    supportsInstructionSetup: true,
    supportsHooks: false,
    instructionTarget: ".clinerules",
  },
  "kilo-code": {
    verify:
      'Restart Kilo Code. Check Settings → MCP Servers — "agentlink" should appear.',
    supportsInstructionSetup: true,
    supportsHooks: false,
    instructionTarget: ".kilocode/rules/agentlink.md",
  },
  codex: {
    verify:
      "Run codex — it should auto-detect the MCP server from ~/.codex/config.toml.",
    supportsInstructionSetup: true,
    supportsHooks: false,
    instructionTarget: "AGENTS.md",
  },
};

// --- Step 1: Agent picker ---

function AgentPicker({
  knownAgents,
  postCommand,
}: {
  knownAgents: AgentInfo[];
  postCommand: PostCommand;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const agent of knownAgents) {
      if (agent.selected) initial.add(agent.id);
    }
    return initial;
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const save = () => {
    const agents = Array.from(selected);
    if (agents.length === 0) return;
    postCommand("saveAgents", { agents: agents.join(",") });
  };

  return (
    <div class="section">
      <h3>Welcome to AgentLink</h3>
      <p class="help-text">
        AgentLink gives your AI agents native VS Code tools — diff views,
        integrated terminal, diagnostics, and language server intelligence.
      </p>
      <h4 style={{ marginTop: "12px" }}>Select Your Agents</h4>
      <p class="help-text">
        Choose which agents to auto-configure. You can change this later via the
        command palette.
      </p>
      <div class="agent-picker">
        {knownAgents.map((agent) => (
          <label key={agent.id} class="agent-option">
            <input
              type="checkbox"
              checked={selected.has(agent.id)}
              onChange={() => toggle(agent.id)}
            />
            <span>{agent.name}</span>
          </label>
        ))}
      </div>
      <div class="button-group" style={{ marginTop: "8px" }}>
        <button
          class="btn btn-primary"
          onClick={save}
          disabled={selected.size === 0}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// --- Step 2: Confirmation + next steps ---

function OnboardingComplete({
  configuredAgentIds,
  knownAgents,
  postCommand,
}: {
  configuredAgentIds: string[];
  knownAgents: AgentInfo[];
  postCommand: PostCommand;
}) {
  const agentNames = new Map(knownAgents.map((a) => [a.id, a.name]));
  const hasHookAgent = configuredAgentIds.some(
    (id) => AGENT_NEXT_STEPS[id]?.supportsHooks,
  );

  const [instructionsDone, setInstructionsDone] = useState(false);
  const [hooksDone, setHooksDone] = useState(false);

  return (
    <div class="section">
      <h3>Setup Progress</h3>
      <div class="onboarding-checklist">
        <div class="onboarding-check">
          <span class="badge badge-ok">✓</span>
          <span>MCP server configured</span>
        </div>
        <div class="onboarding-check">
          {instructionsDone ? (
            <span class="badge badge-ok">✓</span>
          ) : (
            <span class="badge badge-pending">○</span>
          )}
          <span>Agent instructions set up</span>
        </div>
        {hasHookAgent && (
          <div class="onboarding-check">
            {hooksDone ? (
              <span class="badge badge-ok">✓</span>
            ) : (
              <span class="badge badge-pending">○</span>
            )}
            <span>Enforcement hooks installed</span>
          </div>
        )}
      </div>

      <h4 style={{ marginTop: "16px" }}>Set Up Instructions</h4>
      <p class="help-text">
        Instruction files teach your agents how to use AgentLink tools. This
        writes to each agent's instruction file and keeps them updated
        automatically on future startups.
      </p>
      <div class="onboarding-targets">
        {configuredAgentIds.map((id) => {
          const steps = AGENT_NEXT_STEPS[id];
          if (!steps?.supportsInstructionSetup) return null;
          return (
            <div key={id} class="onboarding-target-row">
              <span class="onboarding-target-agent">
                {agentNames.get(id) ?? id}
              </span>
              <span class="onboarding-target-path">
                → {steps.instructionTarget}
              </span>
            </div>
          );
        })}
      </div>
      <div class="button-group" style={{ marginTop: "8px" }}>
        <button
          class={`btn ${instructionsDone ? "btn-done" : "btn-primary"}`}
          disabled={instructionsDone}
          onClick={() => {
            for (const id of configuredAgentIds) {
              postCommand("setupInstructions", { agentId: id });
            }
            setInstructionsDone(true);
          }}
        >
          {instructionsDone ? "✓ Instructions Set Up" : "Set Up Instructions"}
        </button>
      </div>

      {hasHookAgent && (
        <>
          <h4 style={{ marginTop: "16px" }}>Install Hooks</h4>
          <p class="help-text">
            Hooks block your agent from using built-in tools, forcing it to use
            AgentLink's VS Code-integrated equivalents instead. These are also
            kept updated automatically on future startups.
          </p>
          <div class="button-group" style={{ marginTop: "8px" }}>
            <button
              class={`btn ${hooksDone ? "btn-done" : "btn-primary"}`}
              disabled={hooksDone}
              onClick={() => {
                postCommand("installHooks");
                setHooksDone(true);
              }}
            >
              {hooksDone ? "✓ Hooks Installed" : "Install Hooks"}
            </button>
          </div>
        </>
      )}

      <h4 style={{ marginTop: "16px" }}>Verify Connection</h4>
      {configuredAgentIds.map((id) => {
        const steps = AGENT_NEXT_STEPS[id];
        if (!steps) return null;
        return (
          <div key={id} class="onboarding-agent-section">
            <h5>{agentNames.get(id) ?? id}</h5>
            <div class="onboarding-step">{steps.verify}</div>
          </div>
        );
      })}

      <div class="button-group" style={{ marginTop: "16px" }}>
        <button
          class="btn btn-primary"
          onClick={() => postCommand("dismissOnboarding")}
        >
          Done
        </button>
      </div>
    </div>
  );
}

// --- Main component ---

export function AgentIntegration({ state, postCommand }: Props) {
  const {
    serverRunning,
    agentConfigured,
    onboardingStep,
    knownAgents,
    configuredAgentIds,
  } = state;

  if (onboardingStep === 1 && knownAgents) {
    return <AgentPicker knownAgents={knownAgents} postCommand={postCommand} />;
  }

  if (onboardingStep === 2 && configuredAgentIds && knownAgents) {
    return (
      <OnboardingComplete
        configuredAgentIds={configuredAgentIds}
        knownAgents={knownAgents}
        postCommand={postCommand}
      />
    );
  }

  if (!serverRunning) {
    return (
      <CollapsibleSection title="Agent Configuration">
        <p class="help-text">
          Start the server to configure agent integration.
        </p>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Agent Configuration">
      <div class="info-row">
        <span class="label">MCP Config:</span>
        {agentConfigured ? (
          <span class="badge badge-ok">Configured</span>
        ) : (
          <span class="badge badge-warn">Not configured</span>
        )}
      </div>
      <p class="help-text">
        The extension auto-configures your agents on startup. If you need to set
        it up manually:
      </p>
      <div class="button-group">
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("installCli")}
        >
          Run CLI Setup
        </button>
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("copyCliCommand")}
        >
          Copy CLI Command
        </button>
        <button
          class="btn btn-secondary"
          onClick={() => postCommand("copyConfig")}
        >
          Copy JSON Config
        </button>
      </div>
    </CollapsibleSection>
  );
}
