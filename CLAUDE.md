# Claude Code Instructions

## Building & Installing

- **Build**: `npm run build`
- **Release & install**: `npm run release -- --install` — bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps.

## Adding or Changing Tools

When adding a new tool or changing tool parameters:

1. Register the tool in `src/server/registerTools.ts`
2. Update `CLAUDE.md.example` — add to the "Additional tools" list with a description
3. Update `README.md` — add a full tool section with parameter table and response details
4. Run `npm run release -- --install` to rebuild, reinstall, and re-inject the CLAUDE.md instructions
