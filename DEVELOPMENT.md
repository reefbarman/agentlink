# Development

## Building & Installing

Development requires Node.js 22.19 or newer. With nvm, run `nvm install` once to install the version in `.nvmrc`, then use `nvm use` when returning to the project.

```sh
nvm install
nvm use
npm install
npm run build     # one-shot build
npm run watch     # rebuild on change
```

Press F5 in VS Code to launch the Extension Development Host for testing.

### Release & install

```sh
npm run release -- --install
```

Bumps patch version, builds, packages VSIX, and installs into VS Code. Use `--major` or `--minor` for non-patch bumps.

## Dev-Only Tools

The following tools are registered in dev builds only. They are **not** included in public releases.

### send_feedback

Submit feedback about an AgentLink tool — report issues, suggest improvements, or note missing features. Feedback is stored locally for the extension developer to review.

For MCP server-tool calls, use `call_mcp_tool` as the canonical feedback category for AgentLink integration failures, including tools exposed and invoked directly as `server__tool`. Do not use a server-specific name such as `unity__run_tests` or a bare upstream tool name as `tool_name`; put the MCP server and bare tool in `tool_params` or `feedback`. For MCP management helpers (`find_mcp_tools`, `read_mcp_resource`, and so on), use the AgentLink meta-tool actually called. Ordinary upstream server/domain errors do not need AgentLink feedback unless the problem is AgentLink's MCP transport, approval, dispatch, or result handling.

| Parameter             | Type    | Description                                                            |
| --------------------- | ------- | ---------------------------------------------------------------------- |
| `tool_name`           | string  | AgentLink category; use `call_mcp_tool` for MCP server-tool calls      |
| `feedback`            | string  | Description of the issue, suggestion, or missing feature               |
| `tool_params`         | string? | Parameters passed; include MCP server and bare tool here when relevant |
| `tool_result_summary` | string? | Summary of what happened or the unexpected result received             |

### get_feedback

Read all previously submitted feedback. Optionally filter by tool name.

| Parameter   | Type    | Description                                             |
| ----------- | ------- | ------------------------------------------------------- |
| `tool_name` | string? | Filter to feedback about a specific tool (omit for all) |

### delete_feedback

Delete specific feedback entries by their 0-based index (as returned by `get_feedback`).

| Parameter | Type     | Description                        |
| --------- | -------- | ---------------------------------- |
| `indices` | number[] | Array of 0-based indices to delete |

## Streaming Baseline

Development builds collect bounded, non-reactive streaming metrics for the VS Code gateway, helper Ask Agent, and both transcript webviews. Production builds use no-op recorders and do not mount transcript metric wrappers.

Inspect the current runtime from its own developer console (Extension Host, helper process, VS Code webview, or browser webview):

```js
__agentlinkStreamingBaseline.summarize("browser-webview");
__agentlinkStreamingBaseline.events("browser-webview");
__agentlinkStreamingBaseline.reset("browser-webview");
```

Use the matching surface name: `vscode-gateway`, `ask-agent-helper`, `vscode-webview`, or `browser-webview`. Each process/webview keeps its own latest 50,000 samples and reports dropped samples in the summary.

### Reproduce

- [ ] Run `npx vitest run src/shared/streamingBaselineMetrics.test.ts src/shared/streamingBaselineFixture.test.ts src/agent/webview/components/TranscriptMessageList.test.ts src/browser-gateway/BrowserGatewayService.test.ts src/browser-gateway/BrowserGatewayServer.test.ts`.
- [ ] Run `npx vitest run src/browser-gateway/helper/browserGatewayHelper.integration.test.ts -t "surfaces safe Ask Agent ask_user tool calls and resumes after submitted answers"`.
- [ ] Confirm all fixture and integration assertions pass before comparing later optimizations.

### Current baseline

- [x] Scenarios cover 4- and 200-message transcripts, 1 and 3 SSE clients, 8 text deltas, and 4 tool/approval/final-status transitions.
- [x] Twelve browser-observed updates produce 24 full snapshot builds and serializations, plus 12 broadcasts. The 150 ms VS Code poll can collapse faster token deltas before they become observed updates.
- [x] Broadcast deliveries scale with clients: 12 for one client and 36 for three clients.
- [x] Eight uninterrupted text deltas expose seven coalescing opportunities.
- [x] Unchanged-history commits scale with transcript length: 36 for 4 messages and 2,388 for 200 messages.
- [x] The real helper ask-user pause/resume fixture records 2 text deltas, 2 semantic boundaries, and 9 full snapshot builds; semantic pauses correctly split coalescing bursts.
- [x] The measured per-update amplification is material. Capture turn-level runtime timings for representative model cadences before choosing coalescing windows; continue with shared-history memoization and retain semantic flush boundaries.
