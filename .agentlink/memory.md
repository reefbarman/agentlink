When refactoring AgentLink core, keep `src/core/**` limited to shared multi-surface code or neutral contracts that multiple surfaces can import. Do not move helper-only Ask Agent policy/prompt/session behavior into core just because it exists. When code is moved into core for Browser Ask Agent, audit whether the VS Code main agent can also use it without behavior changes; if the main agent has the hardened implementation, prefer moving Ask Agent toward that shared path rather than replacing main-agent behavior.
<!-- added 2026-06-22 -->

For Browser Ask Agent capability planning, default to matching the VS Code main agent and sharing code/core interfaces where possible, but keep these unsupported for Ask Agent for now: semantic/codebase search and repo maps, editor/language intelligence, write/edit/refactor tools, and Ask-Agent-owned secrets/model credential management. Credential acquisition/refresh remains sourced from connected VS Code instances for now. Shell/process/terminal tools and background agents are future Ask-Agent-specific designs: shell should use a system-terminal/process surface rather than the VS Code terminal, and background agents should be read-only/research-oriented with no writing/escalation.
<!-- added 2026-06-22 -->

For Browser Ask Agent work, treat divergence from the VS Code main agent’s interaction flows as a bug unless the difference is required by browser/security/write restrictions. Prefer shared runtime contracts and parity tests for flows such as `ask_user` pause/resume, final status, todos, retries, stop/cancel, transcript/tool-result semantics, memory/context, and read paths; keep restrictions focused on writes/editor/LSP/shell/secrets rather than reimplementing behavior differently.
<!-- added 2026-06-26 -->

For Browser Ask Agent, VS Code instances may be used as credential sources/refreshers, but Ask-Agent-owned tool execution should run in the helper/core rather than falling back to a VS Code instance endpoint. Image generation specifically must execute in helper/core using leased/cached credentials and surface approvals in the browser Ask Agent tab, not in a VS Code instance.
<!-- added 2026-06-29 -->

For AgentLink work with concurrent dirty changes, use normal Git with exact-path staging and preserve unrelated diffs. Do not default to temporary indexes or compare-and-swap ref plumbing; use those only when a concrete concurrent commit conflict requires them or the user explicitly requests them. Ask the user if an actual commit-boundary conflict cannot be isolated safely.
<!-- added 2026-07-16 -->
