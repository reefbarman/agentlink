import type { AgentModelReference } from "@agentlink/core";
import type { AssistantServerModelChoice } from "./serverConfig.js";

/**
 * The models a client may choose: a fixed list, or a function read on each
 * use so a provider set up while the server runs is offered at once.
 */
export type ModelChoices =
  | readonly AssistantServerModelChoice[]
  | (() => readonly AssistantServerModelChoice[]);

export function currentModels(
  choices: ModelChoices,
): readonly AssistantServerModelChoice[] {
  return typeof choices === "function" ? choices() : choices;
}

/**
 * A model reference whose fields are read from `current` on every access.
 * For engine options that are copied once at startup (the workspace host's
 * default model): copies of this object, spreads and clones take the value
 * at that moment, while the object itself always shows the current one.
 */
export function liveModelReference(
  current: () => AgentModelReference,
): AgentModelReference {
  const reference = {} as AgentModelReference;
  Object.defineProperties(reference, {
    providerId: { enumerable: true, get: () => current().providerId },
    modelId: { enumerable: true, get: () => current().modelId },
  });
  return reference;
}
