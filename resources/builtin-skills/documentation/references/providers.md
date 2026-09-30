# Providers and OpenAI-compatible Setup

AgentLink has first-class ChatGPT/Codex subscription sign-in and OpenAI API-key support. Other providers connect through an **OpenAI Chat Completions-compatible endpoint**, including OpenRouter, local model servers, and Claude through Meridian.

This guide covers VS Code setup and the shared connection file. AgentLink Desktop reads the same file on the same Mac. Browser Ask Agent can use configured models but cannot create or edit provider configuration. For terminal-specific setup, see [Standalone CLI](standalone-cli.md).

## Configure an OpenAI-compatible provider

1. Open the VS Code Command Palette and run **AgentLink: Configure OpenAI-compatible Model**, or choose **Configure another provider** in an empty chat.
2. Choose **OpenRouter** or a generic compatible endpoint. Enter its API root, for example `https://openrouter.ai/api/v1` or `http://127.0.0.1:1234/v1`. Do not include `/chat/completions`: AgentLink appends it.
3. Select or create a named API-key credential. Choose no authentication only when the server permits it, such as a loopback-only local server.
4. Let AgentLink query `/models`, then select a model. If discovery is unavailable, enter the server's exact model ID manually.
5. Review the context and output limits, tool calling, thinking, and image support. Missing catalog metadata uses editable conservative defaults, not verified capabilities. Coding-agent use requires working function/tool calls, not just text completion.
6. Save, select the model with `/model`, and send a short request. A saved credential does not establish connectivity, model entitlement, or available quota.

The wizard is **add-only**: each run creates one model backed by one connection. To edit or remove models, share one endpoint across multiple models, or configure advanced fields, edit `~/.agentlink/openai-compatible.json`.

### Shared connection file

The file uses this envelope. If it already exists, merge entries into its `connections` array rather than replacing your other providers. This illustrative OpenRouter entry needs an accessible upstream model ID and verified limits before use:

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "openrouter",
      "displayName": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "profile": "openrouter",
      "authKey": "openrouter-main",
      "models": [
        {
          "id": "openrouter-my-model",
          "model": "vendor/model-id",
          "displayName": "My model via OpenRouter",
          "contextWindow": 32768,
          "maxOutputTokens": 4096,
          "supportsToolUse": true,
          "supportsThinking": false,
          "supportsImages": false
        }
      ]
    }
  ]
}
```

- Connection `id` is a stable local key and creates provider ID `openai-compatible:<id>`. Use `profile: "generic"` for other Chat Completions-compatible servers.
- Model `id` is AgentLink's unique local selector ID. Model `model` is the exact upstream wire ID, which may contain a vendor prefix. Keep local IDs stable so saved sessions can resolve them.
- `authKey` names a credential, not its value. Run **AgentLink: Set OpenAI-compatible API Key** and select that name to store the key securely; **AgentLink: Clear OpenAI-compatible API Key** removes it. On macOS, the shared Keychain store lets local AgentLink surfaces reuse the credential. Never put API keys in this JSON or static headers.
- Omit `authKey` for a no-auth server. Do not add a dummy key merely because another client's example requires one.
- `contextWindow` and `maxOutputTokens` describe the served model's limits. VS Code agent responses default to 8,192 tokens; optional model-level `agentMaxTokens` overrides that request size and must not exceed `maxOutputTokens`.
- Declare thinking only when supported. Generic connections send no effort field by default. If the endpoint documents one, set connection-level `reasoningEffortMode` to `reasoning_effort`, `reasoning.effort`, or `output_config.effort`, and declare the model's supported `reasoningEfforts` and `defaultReasoningEffort`. These are wire contracts, not interchangeable spellings.
- Optional model-level `modelFamily: "anthropic"` or `"openai"` selects vendor-appropriate prompt guidance. It does not change the endpoint, credential, or API format.

Authenticated endpoints require HTTPS or loopback HTTP by default. Redirects are rejected. Keep local servers on loopback; do not enable `allowInsecureHttp` as a routine fix for network or authentication failures. An endpoint offering only Anthropic Messages or OpenAI Responses is not sufficient for this connection path.

See [Settings: OpenAI-compatible connections](settings.md#openai-compatible-connections) for session-ID mappings, model tiers, response limits, and quota settings.

## Use Claude Code authentication through Meridian

[Meridian](https://github.com/rynfar/meridian) is a third-party local API bridge. Its Claude backend uses Anthropic's Claude Agent SDK and your Claude sign-in, exposing an OpenAI-compatible endpoint that AgentLink can use.

**This adds Claude models to AgentLink, not the Claude Code interface or a nested Claude Code agent.** AgentLink still owns the conversation, tools, approvals, and editor integration. Claude Code authentication belongs to Meridian's backend; it is separate from an optional API key protecting the local Meridian server. Account permissions, model availability, subscription limits, and provider terms still apply. Meridian is installed and maintained separately, not bundled with AgentLink.

### 1. Install, sign in, and start the bridge

Install Node.js 22+ and the Claude Code CLI using their upstream instructions. For a new Meridian installation:

```sh
npm install -g @rynfar/meridian
claude login
MERIDIAN_PASSTHROUGH=1 MERIDIAN_DEFAULT_AGENT=passthrough meridian
```

These shell examples use POSIX syntax. On PowerShell, set the two environment variables with `$env:NAME = "value"` before running `meridian`.

**Passthrough mode is important:** Meridian returns client tool calls for AgentLink to execute through its own permissions and approval flow. Do not configure this as a server-side tool-executing agent. If Meridian already runs as a service, set these variables in that service and restart it when no requests are active, rather than starting a second process on the same port. If you maintain a linked source checkout, preserve that installation instead of replacing it with a global npm install.

Open the dashboard at `http://127.0.0.1:3456`. In another terminal, check startup and discover the model IDs offered by your running version:

```sh
curl -fsS http://127.0.0.1:3456/health
curl -fsS http://127.0.0.1:3456/v1/models
```

The default bind address is loopback. If you enable `MERIDIAN_API_KEY`, authenticated routes such as `/v1/models` need that server key. Use Meridian's authenticated setup instructions and avoid exposing it in copied logs. AgentLink does not need your Claude OAuth token.

### 2. Add the model in AgentLink

Run **AgentLink: Configure OpenAI-compatible Model** and choose a generic endpoint:

- API root: `http://127.0.0.1:3456/v1`.
- Authentication: none for the default unprotected loopback server, or a named credential containing your `MERIDIAN_API_KEY` when enabled.
- Model: choose an ID from Meridian's `/v1/models` response. Review the served context window and output limit, especially if extended context requires extra usage or account access.

After saving, edit that connection in `~/.agentlink/openai-compatible.json` to enable `meridianSessionAffinity`, and set `modelFamily: "anthropic"` on its Claude model. The following is a complete no-auth example for a server offering `claude-sonnet-4-6`; use your catalog's model and limits if they differ. Thinking and images are conservatively disabled here and can be enabled after verifying your server's support.

```json
{
  "schemaVersion": 1,
  "connections": [
    {
      "id": "meridian",
      "displayName": "Claude via Meridian",
      "baseUrl": "http://127.0.0.1:3456/v1",
      "profile": "generic",
      "meridianSessionAffinity": true,
      "quota": {
        "format": "meridian",
        "url": "http://127.0.0.1:3456/v1/usage/quota/all"
      },
      "models": [
        {
          "id": "meridian-sonnet",
          "model": "claude-sonnet-4-6",
          "displayName": "Claude Sonnet via Meridian",
          "modelFamily": "anthropic",
          "contextWindow": 200000,
          "maxOutputTokens": 8192,
          "supportsToolUse": true,
          "supportsThinking": false,
          "supportsImages": false
        }
      ]
    }
  ]
}
```

Merge this connection into an existing file, do not overwrite other entries or add a second connection with the same ID. If the wizard already created it, update that entry instead. For a protected server, add `"authKey": "meridian-local"` to the connection and store the server key with **AgentLink: Set OpenAI-compatible API Key**.

`meridianSessionAffinity` sends AgentLink's current conversation ID as `x-session-affinity`, allowing Meridian to resume its SDK session across tool-loop rounds. Do not add a fixed `x-session-affinity` or `x-session-id` header: AgentLink rejects those static headers, and a shared constant would mix conversations. Do not combine this option with a generic `sessionId` mapping.

The optional `quota` object enables `/usage` for the selected Meridian model in VS Code and browser workspace chats. It queries the configured endpoint only when invoked, displays each profile separately, and reuses the connection credential for this same-origin URL. Meridian's active profile label is not proof of which account served a particular chat. Browser Ask Agent does not currently offer `/usage`.

### 3. Try the connection

- [ ] Select the Claude model with `/model` and send a short message.
- [ ] In a VS Code workspace, ask it to read a small file. Confirm the tool activity appears in AgentLink.
- [ ] Continue the same conversation and check that follow-up tool rounds work.
- [ ] Run `/usage` if quota reporting is configured.

## Troubleshooting

| Symptom                             | Check                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection refused                  | Is the server running on the expected host and port? For Meridian, check `/health`. With a remote VS Code extension host, `127.0.0.1` means that remote host, not your laptop. |
| 404 from model requests             | Use the API root ending in `/v1`, not the dashboard root or the full `/chat/completions` URL. Check that Chat Completions is supported.                                        |
| 401 or 403                          | Check the named credential and server authentication separately from model-account authentication. For Meridian, a valid local server key does not replace Claude sign-in.     |
| Model missing or rejected           | Check `/v1/models` and the exact upstream wire ID. Discovery is user-invoked, not an automatic catalog refresh, and listing a model does not guarantee account entitlement.    |
| Tool calls do not work              | Verify served tool support and `supportsToolUse`. For Meridian, verify passthrough mode. Text-only completion support is not sufficient.                                       |
| Context or output rejected          | Match limits to the served model and account, not another model's advertised maximum. Check `agentMaxTokens` when changing VS Code response size.                              |
| Thinking rejected                   | Check the endpoint's actual effort field and model effort values; do not guess a mapping from the vendor name.                                                                 |
| Meridian quota fails but chat works | Check the optional quota URL, server version, and authentication. Quota configuration does not control model availability.                                                     |

For Meridian installation, service management, account profiles, and current compatibility, use its [configuration guide](https://github.com/rynfar/meridian/blob/main/docs/configuration.md) and [Claude client setup guide](https://github.com/rynfar/meridian/blob/main/docs/agents.md). These upstream guides, not a pinned model list here, own Meridian-specific behavior.
