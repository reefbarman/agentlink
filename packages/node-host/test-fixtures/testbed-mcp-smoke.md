# MCP testbed smoke checklist

Manual smoke test for AgentLink's MCP client using `testbedMcpServer.mjs`. Not part of the automated suite.

## Register

Add both entries to `~/.agentlink/mcp.json` (or the workspace `.agentlink/mcp.json`), then reload the MCP Manager:

```json
{
  "mcpServers": {
    "testbed": {
      "command": "node",
      "args": [
        "/Users/tristan/workspace/agentlink/packages/node-host/test-fixtures/testbedMcpServer.mjs"
      ]
    },
    "testbed-legacy": {
      "command": "node",
      "args": [
        "/Users/tristan/workspace/agentlink/packages/node-host/test-fixtures/testbedMcpServer.mjs"
      ],
      "env": { "TESTBED_ERA": "legacy" },
      "protocol": "legacy"
    }
  }
}
```

Optional env: `TESTBED_MAILBOX=<file>` (shared mailbox, default `$TMPDIR/agentlink-mcp-testbed/mailbox.json`), `TESTBED_TICK_MS=<ms>` (clock interval, default 5000). The server logs to stderr with a `[testbed]` prefix.

Run each check against both servers unless marked otherwise.

## Connection

- [ ] Both servers connect; MCP Manager shows 18 tools.
- [ ] `testbed_info` reports `era: modern` / `2026-07-28` for `testbed`, `era: legacy` / `2025-11-25` for `testbed-legacy`.

## Progress and cancellation

- [ ] `progress_slow_task` (`seconds: 10`): tool row shows live `step N of 10` progress; result says 10 notifications sent.
- [ ] `progress_slow_task` with `indeterminate: true`: progress shows without a percentage.
- [ ] `progress_hang`, then stop the turn: call ends promptly; server stderr has no error. Repeat with `progress_slow_task` (`seconds: 60`) and check the result or stderr reports cancellation.

## Elicitation

- [ ] `elicit_form`: a card opens in the Activity Shelf (not a pop-up) with text, enum, optional integer, and checkbox (default unticked), readable labels and "Optional" markers. Submit, Decline, and Cancel each return the matching `action`, and the tool row shows the matching outcome.
- [ ] `elicit_confirm`: single checkbox; accept returns `confirm`.
- [ ] `elicit_url`: URL prompt opens `https://modelcontextprotocol.io/`.
- [ ] Legacy only: `elicit_url` with `complete_after_seconds: 5`: AgentLink clears the URL prompt after the completion notification.

## List changed

- [ ] `tools_add` (`suffix: one`): `dynamic_one` appears without reconnecting and is callable.
- [ ] `tools_remove` (`name: dynamic_one`): it disappears.
- [ ] `tools_toggle_echo` (`enabled: false`): `echo` disappears; `true` brings it back.
- [ ] `resource_add` (`name: a`): `testbed://note/a` appears in the resource list.

## Not handled yet (expect nothing visible today)

- [ ] `resource_touch_clock`: no update shown. Legacy delivers `resources/updated` only after `resources/subscribe`; the 2026 era drops it (subscriptions use `subscriptions/listen`).
- [ ] `log_levels`: no log entries shown. Legacy sends all eight levels; the 2026 era sends nothing unless the request carries a log level.
- [ ] `mailbox_push_stub`: tool reports sends, but nothing reaches the model or transcript.

## Mailbox (pull-only messaging)

Use two chat tabs. Identity is self-declared.

- [ ] Tab 1: `mailbox_register` as `tab1`; tab 2 as `tab2`.
- [ ] `mailbox_list_sessions` from either tab shows both, with unread counts.
- [ ] Tab 1: `mailbox_send` from `tab1` to `tab2`. Tab 2: `mailbox_read` as `tab2` returns it once; a second read returns none.
- [ ] Tab 2: `mailbox_read` with `wait_seconds: 30`, then send from tab 1: the wait returns early with the message.
- [ ] `mailbox_send` to an unregistered name returns `unknown recipient`.
- [ ] Note for the coordination plan: did you reach for messaging unprompted, and did any message change what the other tab did?
