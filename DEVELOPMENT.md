# Development

## Building & Installing

```sh
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

| Parameter             | Type    | Description                                              |
| --------------------- | ------- | -------------------------------------------------------- |
| `tool_name`           | string  | Name of the tool this feedback is about                  |
| `feedback`            | string  | Description of the issue, suggestion, or missing feature |
| `tool_params`         | string? | The parameters that were passed (helps reproduce)        |
| `tool_result_summary` | string? | Summary of what happened or the result received          |

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
