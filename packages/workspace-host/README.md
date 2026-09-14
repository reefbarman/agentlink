# @agentlink/workspace-host

`@agentlink/workspace-host` composes the portable AgentLink engine into one local-project coding session without depending on VS Code, Electron, a browser gateway, or terminal presentation.

The host owns canonical project identity, durable sessions, provider composition, bounded model requests, project-relative file tools, and durable reviewed-write interactions. Commands, MCP, delegation, and optional language services land in later standalone CLI slices.

`createWorkspaceFileTools(...)` composes bounded read/list/search/context tools with baseline-hash single-file writes and canonical patches. File scopes are resolved per principal, session, and turn; pending approvals bind the exact canonical input, project, scope, baseline, proposed content, and policy revision. Optional session grants receive the complete prepared proposal so callers can bind them to the tool and verified content-hash chain. Successful writes re-read disk content and return a verified final hash with exact durability evidence.

`acquireWorkspaceOwnership(identity, dataRoot)` uses a private local `workspace-owners.json` registry to reserve exclusive CLI writer ownership for a canonical project root, including overlapping roots. It returns an async, idempotent release handle. Callers must pass an explicit absolute data root and release ownership when the session ends.
