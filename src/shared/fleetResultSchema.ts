// VS Code's background result envelopes live in core so every surface
// validates them the same way.
export {
  fleetResultSchemas,
  getFleetResultSchema,
  isWorkspaceRelativeArtifact,
  validateFleetResult,
  type FleetResultType,
} from "@agentlink/core/background-results";
