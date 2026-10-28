// Shared with the standalone hosts; see @agentlink/core/command-classifier.
export {
  classifyCommand,
  isCommandEligibleForReadOnlyExecution,
  isCommandPathInsideWorkspace,
  isTierAtOrBelow,
  StaticCommandTierClassifier,
  type ClassifiedCommand,
  type CommandRiskCode,
  type CommandTier,
  type CommandTierClassifier,
  type CommandTierContext,
  type CommandTierResult,
} from "@agentlink/core/command-classifier";
