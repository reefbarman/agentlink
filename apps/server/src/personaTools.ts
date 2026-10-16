import {
  defineTool,
  type HostTool,
  type HostToolResult,
} from "@agentlink/core";
import type {
  WorkspaceApprovalHostTools,
  WorkspaceHostToolApproval,
} from "@agentlink/workspace-host";

import {
  MAX_NAME_LENGTH,
  MAX_OWNER_NAME_LENGTH,
  MAX_PERSONA_LENGTH,
  PERSONA_CHANGE_DISPLAY_KIND,
  PersonaInputError,
  describePersonaChanges,
  parsePersonaPatch,
  type PersonaChangeDisplay,
  type PersonaPatch,
  type PersonaStore,
} from "./persona.js";

/**
 * `propose_persona_change`: a chat proposes a change to the Assistant's
 * name, voice, the owner's name, time zone or quiet hours. It always stops
 * for the owner's approval, whatever the chat's approval mode; the card
 * shows the old and new values, and exactly that change is applied, only
 * if the settings were not changed meanwhile.
 */

export const PERSONA_TOOL_NAMES = ["propose_persona_change"] as const;
const PREPARED_KEY = "preparedPersonaChange";

interface PreparedChange {
  readonly expectedUpdatedAt: number;
  readonly patch: PersonaPatch;
}

const EXPLAIN: Record<string, string> = {
  persona_invalid: "pass the fields to change",
  persona_field_unknown: "unknown field",
  persona_name_invalid: `name must be 1 to ${MAX_NAME_LENGTH} characters on one line`,
  persona_text_invalid: `persona must be 1 to ${MAX_PERSONA_LENGTH} characters, or null for the default`,
  persona_owner_name_invalid: `ownerName must be 1 to ${MAX_OWNER_NAME_LENGTH} characters on one line, or null to clear it`,
  persona_time_zone_invalid:
    'timeZone must be an IANA name such as "Australia/Brisbane"',
  persona_quiet_hours_invalid:
    'quietHours must be {"start":"HH:MM","end":"HH:MM","allowApprovals"?:true} with different times, or null to turn them off',
  nothing_to_change: "the change sets nothing new",
  persona_changed:
    "the settings changed after this was proposed; propose the change again",
};

export function createPersonaTools(options: {
  readonly store: PersonaStore;
  readonly onChanged?: () => void;
  readonly now?: () => number;
}): WorkspaceApprovalHostTools {
  const { store } = options;
  const now = options.now ?? Date.now;

  const prepare = (
    input: Readonly<Record<string, unknown>>,
  ): WorkspaceHostToolApproval => {
    try {
      const patch = parsePersonaPatch(toPatchInput(input));
      const current = store.get();
      const changes = describePersonaChanges(current, patch);
      if (changes.length === 0) {
        throw new PersonaInputError("nothing_to_change");
      }
      const display: PersonaChangeDisplay = {
        kind: PERSONA_CHANGE_DISPLAY_KIND,
        action: "update",
        text: [
          "Change how the Assistant sounds and works:",
          "",
          ...changes,
        ].join("\n"),
      };
      const prepared: PreparedChange = {
        expectedUpdatedAt: current.updatedAt,
        patch,
      };
      return {
        decision: "require_user",
        summary: "Change the Assistant's persona settings?",
        displayContent: display,
        preparedInput: { [PREPARED_KEY]: prepared },
      };
    } catch (error) {
      if (error instanceof PersonaInputError) {
        return { decision: "deny", reason: EXPLAIN[error.code] ?? error.code };
      }
      throw error;
    }
  };

  const stale = (change: PreparedChange): string | undefined =>
    store.get().updatedAt === change.expectedUpdatedAt
      ? undefined
      : EXPLAIN.persona_changed;

  const apply = async (
    input: Record<string, unknown>,
  ): Promise<HostToolResult> => {
    const change = input[PREPARED_KEY];
    if (!isPreparedChange(change)) {
      return {
        modelContent: "This change was not approved by the owner",
        isError: true,
      };
    }
    const reason = stale(change);
    if (reason)
      return { modelContent: `Not applied: ${reason}`, isError: true };
    const next = await store.update(change.patch, now());
    options.onChanged?.();
    return {
      modelContent: `Saved. It applies from the next turn. Name: ${next.name}; time zone: ${next.timeZone}.`,
      displayContent: { action: "update" },
    };
  };

  const proposePersonaChange: HostTool = defineTool({
    name: "propose_persona_change",
    description:
      "Propose a change to how the Assistant sounds and works for the owner: its name, its persona (voice and manner), the owner's name, the owner's time zone, or quiet hours for notifications. Pass only the fields to change. The owner approves the exact change on a card first, so propose it directly when the owner asks. This never changes permissions or approvals.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_NAME_LENGTH },
        persona: {
          type: "string",
          maxLength: MAX_PERSONA_LENGTH,
          description:
            'The full new persona text (second person, how to sound); "" for the default',
        },
        ownerName: {
          type: "string",
          maxLength: MAX_OWNER_NAME_LENGTH,
          description: 'What to call the owner; "" to clear',
        },
        timeZone: {
          type: "string",
          description: 'IANA time zone, for example "Australia/Brisbane"',
        },
        quietHoursOff: {
          type: "boolean",
          description: "true turns quiet hours off",
        },
        quietHours: {
          type: "object",
          additionalProperties: false,
          description:
            "When push notifications wait (Inbox entries still appear)",
          properties: {
            start: { type: "string", description: "HH:MM, 24-hour" },
            end: { type: "string", description: "HH:MM, 24-hour" },
            allowApprovals: {
              type: "boolean",
              description: "Approval requests still notify (default true)",
            },
          },
          required: ["start", "end"],
        },
      },
    },
    displayInput: (input) => input,
    effect: "write",
    authorization: "required",
    presentation: { title: "Change the persona" },
    handler: async (input) => apply(input),
  });

  return {
    toolNames: PERSONA_TOOL_NAMES,
    resolveTools: () => [proposePersonaChange],
    prepare: (request) => prepare(request.input),
    validatePending: ({ input }) => {
      const change = input[PREPARED_KEY];
      if (!isPreparedChange(change)) {
        return { ok: false, reason: "The persona change is not available" };
      }
      const reason = stale(change);
      return reason ? { ok: false, reason } : { ok: true };
    },
  };
}

/** The tool's input as a settings patch: "" resets, quietHoursOff clears. */
export function toPatchInput(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { quietHoursOff, ...rest } = input;
  const patch: Record<string, unknown> = { ...rest };
  if (patch.persona === "") patch.persona = null;
  if (patch.ownerName === "") patch.ownerName = null;
  if (quietHoursOff === true) patch.quietHours = null;
  return patch;
}

function isPreparedChange(value: unknown): value is PreparedChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.expectedUpdatedAt === "number" &&
    !!change.patch &&
    typeof change.patch === "object"
  );
}
