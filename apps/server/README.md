# @agentlink/server

Standalone AgentLink assistant server. Private and experimental: this package contains the access layer, the authenticated workspace-session routes, and a runnable service with a container image (the supported deployment) plus systemd and launchd definitions. The web app and jobs come in later slices.

Supported hosts: Linux (Ubuntu) and macOS. The package uses only portable Node.js APIs (Node 22.19+), and its test suite runs on both.

## Running the server

`npm run build --workspace apps/server` bundles everything into one file, `dist/agentlink-server.js`, which runs with Node 22.19+ on Linux and macOS.

```sh
agentlink-server --config /etc/agentlink/server.json --check   # validate and exit
agentlink-server --config /etc/agentlink/server.json           # serve until SIGTERM/SIGINT
agentlink-server recover --config /etc/agentlink/server.json   # print a recovery code
agentlink-server export-ca --config /etc/agentlink/server.json > agentlink-ca.pem
agentlink-server codex-login --config /etc/agentlink/server.json # sign in with ChatGPT
agentlink-server codex-logout --config /etc/agentlink/server.json
```

`--config` can be omitted when `AGENTLINK_SERVER_CONFIG` names the file; the container image sets it.

`--check` validates the configuration, TLS certificate and key, project directories, and provider secrets without taking locks or listening. On first start without an owner, the server writes a single-use setup credential to stderr (the journal under systemd, the log file under launchd); see [Access layer](#access-layer). SIGTERM stops running turns, waits for them, and exits 0. A second signal exits immediately.

### Configuration

One JSON file. Relative paths resolve against its directory, and unknown keys are rejected so a typo cannot silently drop a setting. Examples: [`deploy/server.linux.example.json`](deploy/server.linux.example.json) and [`deploy/server.macos.example.json`](deploy/server.macos.example.json).

| Key             | Meaning                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataRoot`      | Access state (`server/`), workspace session data (`workspace/`), and the local CA (`tls/`). Created `0700`.                                                                                                                                                 |
| `listen`        | `{ host, port }`. Bind a LAN address explicitly; there is no default.                                                                                                                                                                                       |
| `publicOrigins` | Exact `https://` origins browsers use. The `Host` header must match one.                                                                                                                                                                                    |
| `tls`           | `{ "localCa": true }` (see [Device trust](#device-trust)), or `{ certFile, keyFile }` with a key not readable by others (`0600` or `0640`).                                                                                                                 |
| `providers`     | `codex` (`modelIds`, ChatGPT sign-in), `openai` (`modelIds`, `apiKey`), or `openai-compatible` (`baseURL`, `models`, and `apiKey` or `noAuth: true`). Remote providers must use HTTPS; see [Meridian](#claude-models-meridian) for the container exception. |
| `defaultModel`  | `{ providerId, modelId }`. The model must be declared by that provider.                                                                                                                                                                                     |
| `modelRoles`    | Optional. `{ "review": { providerId, modelId } }` names the model a client gets when it creates a session with `{ "role": "review" }`, for example Claude through [Meridian](#claude-models-meridian). The model must be declared.                          |
| `projects`      | `[{ id, label?, root }]`. Each is mounted at `/api/projects/<id>` with file tools enabled. Commands are not enabled yet.                                                                                                                                    |
| `ripgrepPath`   | Optional absolute `rg` binary for `search_files`.                                                                                                                                                                                                           |

API keys are never inline. `{ "file": "/path" }` reads a file that must not be readable by group or others. `{ "credential": "name" }` reads `$CREDENTIALS_DIRECTORY/name`, which systemd provides through `LoadCredential=` or `LoadCredentialEncrypted=` (use `systemd-creds encrypt` to bind the key to the TPM). Keys are reread on each use, so rotation needs no restart.

### ChatGPT sign-in (Codex)

A `{ "type": "codex", "modelIds": ["gpt-6.1-sol"] }` provider uses a ChatGPT subscription instead of an API key. The server has no browser, so `codex-login` prints a sign-in link to open on any device. After signing in, that browser is sent to an `http://localhost:1455/auth/callback?...` address that does not load; paste that address back into the command. The pasted address must carry the state of the flow the command started, so an address from another sign-in is refused.

Tokens are stored in `<dataRoot>/credentials/codex-sign-in.json` (directory `0700`, file `0600`; the server refuses a file others can read) and refreshed automatically. Run the command as the service account. The running server and the command share the file under a lock, so signing in or out takes effect without a restart. A server with no sign-in still starts; `--check` and the startup log say whether it is signed in, and model requests fail until it is. Signing in again with the same account updates it; a different account is added and becomes active. `codex-logout` removes every stored sign-in.

### Container (Docker)

The supported deployment. [`deploy/container/Dockerfile`](deploy/container/Dockerfile) builds a small image (Node 22, git, ripgrep, the bundle) that runs as a non-root user, and [`deploy/container/compose.yaml`](deploy/container/compose.yaml) runs it with a read-only root filesystem, no capabilities, `no-new-privileges`, an init process, and bounded logs. The host keeps no firewall or service-account changes; only the directories you mount are visible to the server. The same image runs on Linux and on macOS with Docker Desktop.

```sh
# Build (from the repository root)
npm run build:workspaces
docker build -t agentlink-assistant:local -f apps/server/deploy/container/Dockerfile apps/server

# Deploy directory: compose.yaml, server.json (from deploy/container/server.example.json)
mkdir -m 700 data && mkdir -p projects/home
docker compose up -d
docker compose logs assistant                                  # setup credential, CA fingerprint
docker compose exec assistant agentlink-server codex-login     # ChatGPT sign-in
docker compose exec assistant agentlink-server export-ca > agentlink-ca.pem
docker compose exec assistant agentlink-server recover
```

- **Ownership.** The container runs as uid/gid 1000 by default (`AGENTLINK_UID`/`AGENTLINK_GID` in `.env`), so `data/` and `projects/` belong to the host user. Create them before the first start, or Docker creates them owned by root.
- **Network.** The port is published on all addresses by default (`AGENTLINK_PUBLISH`, for example `192.168.1.20:8443`, narrows it). Docker publishes ports outside ufw, so ufw neither blocks nor protects it. Binding a single LAN address fails at boot if that address is not up yet. The server answers only HTTPS, only for `publicOrigins`, and only to signed-in devices.
- **Config.** In the container, `listen` is `0.0.0.0:8443`, `dataRoot` is `/var/lib/agentlink`, and project roots are under `/srv/agentlink/projects`. `publicOrigins` lists the addresses devices use on the LAN.
- **Restarts.** `restart: unless-stopped` brings it back after a crash or reboot. Locks record the hostname and process start time, so a lock left by the previous run of the same container is not mistaken for a live one when the new process gets the same PID.
- **Admin commands.** Use `docker compose exec`, which runs inside the service's container. A separate container on the same `data/` (`docker compose run`, or a recreated container after a crash) cannot check the holder's PID, so it honours a lock until its 15-second heartbeat is 60 seconds old; a recreated container may restart a few times before it acquires its locks.

### Claude models (Meridian)

[Meridian](https://github.com/rynfar/meridian) serves Claude models through your own Claude sign-in as an OpenAI-compatible endpoint. [`deploy/container/compose.meridian.yaml`](deploy/container/compose.meridian.yaml) runs it as a second service beside the assistant:

- **Not published.** Meridian has no `ports:`; only containers in this compose project can connect, as `http://meridian:3456`. The host's LAN address does not answer on 3456.
- **Keyed.** Every request needs the shared key in `secrets/meridian-api-key`. Compose mounts it into both containers at `/run/secrets/meridian-api-key`; Meridian loads it into `MERIDIAN_API_KEY` inside its own process, so it is not in the container configuration.
- **Hardened like the assistant.** Runs as uid 1000 with a read-only root filesystem, no capabilities, and `no-new-privileges`. Its sign-in, settings, plugins, and session state live in `meridian/` (Meridian's home directory).
- **Plain HTTP on purpose.** Traffic stays on the private Docker network. The server accepts `http://` to a provider only for loopback, or for a single-label container name (like `meridian`) with `"allowInsecureHttp": true`. LAN addresses and dotted names must use HTTPS, so a key never crosses the network in the clear.

```sh
# In the deploy directory, once
docker build -t meridian:local https://github.com/rynfar/meridian.git#meridian-v1.80.0
mkdir -m 700 secrets meridian
(umask 077 && openssl rand -hex 32 > secrets/meridian-api-key)
echo "COMPOSE_FILE=compose.yaml:compose.meridian.yaml" >> .env
docker compose up -d

# Sign in to Claude: open the printed link, sign in, paste the code back.
# Saved in meridian/.config/meridian/profiles; no restart needed.
docker compose exec meridian node dist/cli.js profile add claude --headless
docker compose exec meridian node dist/cli.js profile list

# AgentLink's Meridian plugin (from an AgentLink checkout)
node integrations/meridian-plugin-agentlink/install.mjs meridian/.config/meridian/plugins
docker compose restart meridian
```

Install the [AgentLink plugin](../../integrations/meridian-plugin-agentlink/README.md). Without it, Meridian treats the assistant as a generic OpenAI client: it defers AgentLink's tools and can run extra hidden model turns before handing a tool call back. With it, tool calls return to the assistant in one turn and the assistant runs them under its own approvals. It applies only to requests that carry the session-affinity header (`meridianSessionAffinity: true`) and AgentLink's prompt. To check, `GET /plugins/list` on Meridian should show `agentlink-client-tools` as `active`, and `GET /telemetry/requests` should show `isPassthrough: true` and `hasDeferredTools: false` for assistant requests. Sessions created before the plugin was loaded keep their old behaviour; start a new session.

Then add the provider to `server.json` (full example: [`deploy/container/server.with-meridian.example.json`](deploy/container/server.with-meridian.example.json)) and `docker compose restart assistant`:

```json
{
  "type": "openai-compatible",
  "id": "claude",
  "baseURL": "http://meridian:3456/v1",
  "allowInsecureHttp": true,
  "apiKey": { "file": "/run/secrets/meridian-api-key" },
  "meridianSessionAffinity": true,
  "models": [
    {
      "id": "claude-opus-5-5",
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "supportsToolUse": true,
      "supportsThinking": true,
      "promptProfile": "reasoning"
    }
  ]
}
```

To run reviews on Claude while everything else uses the default model, add `"modelRoles": { "review": { "providerId": "claude", "modelId": "claude-opus-5-5" } }` and create review sessions with `{ "role": "review" }` (see [Model selection](#model-selection)).

`meridianSessionAffinity` lets Meridian resume each conversation's Claude session. Use the context window Meridian's `/v1/models` reports for your plan; 200k is safe for every plan. Requests use your Claude subscription's limits. To rotate the key, replace the file and `docker compose up -d --force-recreate`.

### Ubuntu (systemd)

[`deploy/systemd/agentlink-server.service`](deploy/systemd/agentlink-server.service) runs the bundle as a dedicated `agentlink` system user with state in `/var/lib/agentlink` (`StateDirectory`, `0700`), read-only config in `/etc/agentlink`, and projects in `/srv/agentlink/projects`. The file header lists the install commands. It is hardened (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, restricted namespaces and address families) and scores 3.0 ("OK") in `systemd-analyze security`. `MemoryDenyWriteExecute` is deliberately off because V8's JIT needs it. Adjust `ExecStart` if Node is not `/usr/bin/node`.

### macOS (launchd)

[`deploy/launchd/local.agentlink.server.plist`](deploy/launchd/local.agentlink.server.plist) is a LaunchDaemon that runs as a hidden `_agentlink` user with a `0077` umask and restarts on failure. Logs, including the setup credential, go to `/usr/local/var/log/agentlink/server.log`; keep that directory private to the service user. The plist header lists the install commands. API keys use `{ "file": ... }` with a `0600` file.

### Device trust

With `"tls": { "localCa": true }` the server creates its own certificate authority (CA) on first start, in `<dataRoot>/tls`, and issues its HTTPS certificate from it. Install the CA once on each phone, tablet, and computer, and browsers trust the server with no warnings.

The CA is **name-constrained** to the hosts in `publicOrigins`: devices that trust it accept it only for those hostnames (and names under them, such as `x.framework16.local`, which is how DNS name constraints work) and those exact IP addresses, never for any other website, even if its key leaked. The trade-off is that changing `publicOrigins` needs a new CA. The server refuses to start rather than replace a CA silently; move `<dataRoot>/tls` aside, restart, and install the new CA on every device. The CA is valid for 10 years. The server certificate is valid for a year and is renewed automatically within 30 days of expiry (checked every 12 hours, no restart).

Prefer a hostname origin, such as the machine's mDNS name (`https://framework16.local:8443`), alongside or instead of an IP address: it survives DHCP address changes, which would otherwise need a new CA.

`<dataRoot>/tls/ca-key.pem` holds the CA key and certificate together and is the only authoritative copy; back it up privately. `ca.pem` is a public copy that is rebuilt from it if missing.

Export the CA (it is public; only `ca-key.pem` is secret and it never leaves the server):

```sh
# Ubuntu
sudo -u agentlink /usr/bin/node /opt/agentlink/server/agentlink-server.js export-ca --config /etc/agentlink/server.json > agentlink-ca.pem
# macOS
sudo -u _agentlink /opt/homebrew/bin/node /usr/local/lib/agentlink/server/agentlink-server.js export-ca --config /usr/local/etc/agentlink/server.json > agentlink-ca.pem
```

It prints the CA's SHA-256 fingerprint on the terminal, as does the service log at startup. Move the file to each device over a channel you trust (AirDrop, USB, your own email), and compare the fingerprint the device shows before trusting it.

- **iPhone and iPad:** open the file (AirDrop or Files), then Settings → General → VPN & Device Management → install the profile. Then turn on full trust in Settings → General → About → Certificate Trust Settings.
- **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate (the menu path varies by manufacturer). Chrome uses it. Firefox needs its "use third-party CA certificates" setting.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain agentlink-ca.pem`, or import it into the System keychain in Keychain Access and set it to Always Trust.
- **Windows:** `certutil -user -addstore Root agentlink-ca.pem`.
- **Ubuntu desktop:** `sudo cp agentlink-ca.pem /usr/local/share/ca-certificates/agentlink-ca.crt && sudo update-ca-certificates` for system tools. Chrome and Firefox on Linux keep their own lists: import it as an authority in their certificate settings.

To stop trusting the server, remove the profile or certificate from the device.

### Restarts and crashes

Sessions, the owner, devices, and pairings survive restarts. A turn that was running when the process died is marked interrupted at startup. After a hard crash the dead process's turn lease stays valid for up to 30 seconds and is never broken early: the server starts immediately, that session reports `409 session_busy`, and recovery completes in the background once the lease expires.

### Lost access

If every signed-in browser is gone (cookies cleared, devices revoked or lost), run `recover` on the server machine as the service account. It works while the server is running:

```sh
# Ubuntu
sudo -u agentlink /usr/bin/node /opt/agentlink/server/agentlink-server.js recover --config /etc/agentlink/server.json
# macOS
sudo -u _agentlink /opt/homebrew/bin/node /usr/local/lib/agentlink/server/agentlink-server.js recover --config /usr/local/etc/agentlink/server.json
```

It prints a single-use code, valid for 15 minutes, to the terminal only (never to the service log). Redeem it at `POST /api/auth/recover` with the owner passphrase. Running it again replaces the code. It refuses to run as any account other than the owner of the data root, before an owner exists, or when the access state is corrupt. A forgotten passphrase is not recoverable this way; stop the server and delete `server/access-state.json` to start over with a new setup credential.

## Access layer

`createAssistantServer(options)` starts an HTTPS-only listener (TLS 1.2+, certificate and key required, no plain-HTTP mode) that owns authentication:

- **Owner bootstrap.** While no owner exists, `start()` issues a 15-minute setup credential to `onSetupCredential`, which must only show it locally. `POST /api/auth/bootstrap` redeems it once with an owner passphrase (12+ characters) and returns a session.
- **Device pairing.** A signed-in, recently reauthenticated owner creates a single-use code (`POST /api/auth/pairings`, 5 minutes). A new browser redeems it at `POST /api/auth/pairings/redeem`. There is no passphrase login for unknown browsers.
- **Sessions.** `__Host-agentlink_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`), 30-day absolute and 7-day idle expiry. `GET /api/auth/session` returns the session and its CSRF token. `POST /api/auth/logout` ends it, and `DELETE /api/auth/devices/:id` revokes a device and all its sessions, including the last one; sign in again with [local recovery](#lost-access).
- **Local recovery.** `agentlink-server recover` writes a hash of a 15-minute code to `<dataRoot>/recovery-request.json` (`0600`) without taking the store lock. `POST /api/auth/recover` needs that code and the owner passphrase, creates a new device and session, and deletes the file. The server ignores the file unless it is a regular file owned by its own account and private to it. A wrong passphrase does not consume the code, and attempts share the credential rate limiter.
- **Reauthentication.** `POST /api/auth/reauthenticate` checks the scrypt-hashed passphrase. Sensitive routes need it within the last 5 minutes.
- **Request guard.** Every request and upgrade is rejected when it carries `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `X-Remote-User`, `X-Auth-Request-*` or similar identity/proxy headers, when `Host` is not a configured public origin, when `Origin` is foreign, or when `Sec-Fetch-Site` is `cross-site`. Unsafe methods and upgrades require `Origin`. Authenticated unsafe requests also need `x-agentlink-csrf`.
- **Rate limiting.** Setup, pairing, and passphrase guesses are limited per socket address and globally, and attempts still in flight count against the limit. Client headers never select the key.

`handleRequest` and `handleUpgrade` only ever see authenticated requests. Their `auth` context carries:

- an explicit `{ tenantId: "agentlink-server", subjectId: ownerId }` principal, never derived from a project identity;
- `recentlyAuthenticated`, as of when the request was authenticated;
- `signal`, which aborts when the request closes or as soon as its session or device is revoked;
- `revalidate()`, a check-only recheck of revocation, expiry, and current reauthentication. It does not count as client activity, so it never extends the idle window.

`onClose` runs during `close()`, after the listener stops accepting connections and before open connections and the access store close. Use it to stop application work.

State lives in `<dataRoot>/access-state.json` (directory `0700`, file `0600`). Only hashes of setup credentials, session tokens, and the passphrase are stored. A corrupt file stops startup rather than reopening bootstrap. Each write is fsynced, including the directory, before a response reports success. An exclusive `access-state.lock` lets only one live process own a data root; `close()` releases it, and a lock left by a dead process is replaced (under a `.reclaim` marker, so two starting processes cannot both take it).

## Workspace sessions

`createAssistantWorkspaceRoutes({ projects, authorizeProject, models })` mounts one or more workspace hosts. Pass its `handleRequest` to the server and its `close` as `onClose`.

- **Explicit project access.** `authorizeProject({ principal, projectId, access })` maps the server principal to `read`, `write`, or `approve` on each mounted project. It is required; `ownerProjectAccess(store)` grants everything to the bootstrapped owner and nothing to anyone else. The host still runs as its own project principal.
- **Routes.** `GET /api/projects`, `GET /api/projects/:id/models`, `GET|POST /api/projects/:id/sessions`, `GET .../sessions/:sid` (snapshot, model, running task, and event cursor), `POST .../turns`, `POST .../model`, `POST .../interaction`, `POST .../cancel`, `GET .../events`, and the [background agent](#background-agents) routes under `.../agents`.
- **Server-owned turns.** A turn or resume runs on the server, not the request: closing the browser does not cancel it. One task runs per session at a time (`409 session_busy`). A cancelled or failed turn leaves the session `interrupted`, which accepts the next turn. Server shutdown aborts running tasks and waits for them.
- **Approvals.** `POST .../interaction` needs `approve` access and reauthentication within the window. The decision names the exact `interactionId` and `interactionRevision` the owner saw. A mismatch returns `409 stale_interaction`, and the host binds the same pair into the engine's atomic resume, so a decision cannot reach a replacement request. Revocation and reauthentication are rechecked immediately before the resume starts, and a revoked session stops reading a stalled request body.
- **Event stream.** `GET .../events` is Server-Sent Events. Events carry `id: <epoch>:<sequence>`. Reconnect with `?epoch=&after=` (or `Last-Event-ID`) to replay retained events. A `reset` control event means the cursor cannot be served (server restarted or the event aged out) and the client should re-read the snapshot. The stream closes on revocation and rechecks the session every heartbeat. A backpressured reader is caught up from the retained log once it drains; one that stays stalled for 30 seconds is dropped and can reconnect.

### Model selection

Each session has its own model, chosen from the models `server.json` declares. Nothing outside that list is accepted, so a client cannot point a session at another endpoint.

- `GET /api/projects/:id/models` (read access) returns `{ models, defaultModel, roles }`. Each model is `{ providerId, modelId, displayName?, providerDisplayName? }`.
- `POST /api/projects/:id/sessions` takes an optional body: `{ "model": { providerId, modelId } }` or `{ "role": "review" }`, not both. No body uses `defaultModel`. Errors: `400 model_not_available`, `model_role_not_configured`, `model_selection_invalid`, or `model_invalid`.
- `POST .../sessions/:sid/model` (write access) changes the model between turns with the same body. It returns `409 session_busy` while a turn runs and `409 interaction_pending` while an approval waits.
- Session reads and lists include `model`: the session's own choice, or `defaultModel` if it has none.

A review can also be an ordinary session on the review model.

### Background agents

A session's agent can start up to two one-level child agents with `spawn_background_agent`, for example to review its work on Claude while it continues. Children are background sessions of the same project:

- **Scoped.** Each child gets explicit project-relative read paths and, optionally, write paths. A child with no write paths is read-only and cannot write at all, which is what a reviewer gets. Sibling write paths must not overlap.
- **Model.** A child uses its parent session's model unless the agent passes `model_role` (one of `modelRoles`, so `"review"` when configured) or a provider and model that the server has configured. The prompt tells the agent to spawn reviews read-only with `model_role: "review"`.
- **Owner approval.** A child's writes pause for the owner exactly like the parent's. Children cannot delegate, and they are reachable only through their parent: `GET` or `POST` on a child's own session path returns `404 session_not_found`.

Routes, under `/api/projects/:id/sessions/:sid/agents`:

| Route                           | Access                     | Body                          | Result                                                                                                                                     |
| ------------------------------- | -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET .../agents`                | `read`                     |                               | `{ agents }`: each child's lifecycle, phase, scopes, model, current tool, bounded partial output, result text, and any pending `approval`. |
| `POST .../agents/:cid/steer`    | `write`                    | `{ message }` (up to 64 KiB)  | `202 { status: "queued" }`. Applied at the child's next completed turn; it does not interrupt a request or tool.                           |
| `POST .../agents/:cid/stop`     | `write`                    | optional `{ reason }`         | `200 { agent }`, cancelled, with partial output kept.                                                                                      |
| `POST .../agents/:cid/approval` | `approve`, reauthenticated | `{ interactionId, decision }` | `200 { agent }`. The decision applies only to that exact pending request; anything else is `409 stale_interaction`.                        |

Errors: `404 agent_not_found` (unknown, or owned by another session), `409 agent_not_running`, `409 steering_queue_full`. The parent's event stream carries `{ kind: "agent", state, childSessionId }` events for `approval_required`, `approval_answered`, `steered`, and `stopped`, plus `{ kind: "agent", state: "updated", childSessionId, lifecycle, phase, currentTool? }` whenever a child's lifecycle, phase, or current tool changes, including `completed`, `failed`, `cancelled`, and `awaiting_approval`. Updates carry state only, never output text, and do not fire for every streamed token. Re-read `GET .../agents` for the result or partial output; there is no need to poll while a child runs. Server shutdown stops running children, and children that were running when the server stopped are reported `interrupted` after restart; nothing is replayed.

The event log is in memory, so it only bridges reconnects within one server process. The durable session repository remains the source of truth.

Not yet provided: passkeys, command execution, an installer, and the web app.
