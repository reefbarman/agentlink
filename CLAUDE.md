# Claude Code Instructions

## Building & Installing

- **Build**: `npm run build`
- **Release & install**: `npm run release -- --install` — bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps. Don't currently run when developing the agent.

## Branding

- **Brand color**: `#4EC9B0` (teal) — used in `media/agentlink-terminal.svg` and throughout the chat webview UI (file picker indicator, active states)
- **Icon**: `media/agentlink.svg` uses `currentColor` (themed by VS Code); `media/agentlink-terminal.svg` uses the hardcoded brand color

## Verification

After completing any task, **always** run:

1. `npm run lint` — type-checks all tsconfigs (`tsc --noEmit`) and runs oxlint. Fix **all** errors and warnings before considering the task done.
2. `npm test` — runs the vitest suite. Fix any failures.

Both must pass cleanly (zero exit code, no warnings) before a task is considered complete.

## Adding or Changing Tools

When adding a new tool or changing tool parameters:

1. Register the tool in `src/server/registerTools.ts`
2. Update `resources/claude-instructions.md` — add to the "Additional tools" list with a description
3. Update `README.md` — add a full tool section with parameter table and response details
4. Run `npm run release -- --install` to rebuild, reinstall, and re-inject the CLAUDE.md instructions. (Not when developing the agent, though)
